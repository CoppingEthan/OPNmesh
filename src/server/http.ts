/**
 * Route-handler plumbing: JSON responses, body validation, error mapping,
 * and the two authentication wrappers (admin session, gateway token).
 */
import { z, type ZodType } from "zod";
import { AuthError, sessionFromToken, tokenFromRequest, type AdminSession } from "./auth";
import { ClientError } from "./clients";
import { env } from "./env";
import { SettingsError, publicUrl } from "./settings";
import { SiteError, gatewayByToken } from "./sites";
import type { GatewayRow } from "@/db/schema";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message, detail: e.detail }, e.status);
  if (e instanceof AuthError || e instanceof SiteError || e instanceof ClientError) return json({ error: e.message }, e.status);
  if (e instanceof SettingsError) return json({ error: e.message }, 400);
  if (e instanceof z.ZodError) {
    const issues = e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    return json({ error: issues.join("; "), issues }, 400);
  }
  console.error("[opnmesh] unhandled error in route:", e);
  return json({ error: "internal error" }, 500);
}

export const MAX_BODY = 1 << 20;

/**
 * The request body as text, refused as soon as it passes MAX_BODY. A chunked
 * upload has no Content-Length, so the limit is enforced while reading:
 * `req.text()` would buffer any size first, and Next applies no limit of its
 * own to route handlers.
 */
async function readBody(req: Request): Promise<string> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) throw new HttpError(413, "body too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "body too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    const textBody = await readBody(req);
    raw = textBody.length === 0 ? {} : JSON.parse(textBody);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "body must be JSON");
  }
  return schema.parse(raw);
}

/**
 * CSRF protection for mutations. Browsers send Origin with every POST, PUT,
 * PATCH and DELETE, so the request is accepted when Origin is this
 * controller: its public URL, or the host the request was addressed to (so
 * the dashboard also works by IP address) with the public URL's scheme.
 * X-Forwarded-Host counts only behind a configured proxy, which sets it;
 * otherwise a client could choose it. A request without Origin is refused
 * when the browser marks it as coming from another site; with neither
 * header it is not from a browser, and CSRF cannot forge those.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
    const site = req.headers.get("sec-fetch-site");
    return site === null || site === "same-origin" || site === "none";
  }
  let o: URL;
  let pub: URL;
  try {
    o = new URL(origin);
    pub = new URL(publicUrl());
  } catch {
    return false;
  }
  if (o.origin === pub.origin) return true;
  const forwarded = env().trustProxy > 0 ? req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() : undefined;
  const host = forwarded || req.headers.get("host") || new URL(req.url).host;
  return o.protocol === pub.protocol && o.host === host.toLowerCase();
}

type AdminHandler<P> = (req: Request, ctx: { params: P; admin: AdminSession }) => Promise<Response> | Response;

/** Admin session required. Mutating requests must come from the same origin. */
export function withAdmin<P = Record<string, never>>(fn: AdminHandler<P>) {
  return async (req: Request, ctx?: { params: Promise<P> }): Promise<Response> => {
    try {
      const admin = sessionFromToken(tokenFromRequest(req));
      if (!admin) return json({ error: "sign in required" }, 401);
      if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403);
      const params = (ctx ? await ctx.params : {}) as P;
      return await fn(req, { params, admin });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

type GatewayHandler = (req: Request, ctx: { gateway: GatewayRow }) => Promise<Response> | Response;

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,128})$/.exec(h);
  return m ? m[1]! : null;
}

/** Gateway bearer token required. */
export function withGateway(fn: GatewayHandler) {
  return async (req: Request): Promise<Response> => {
    try {
      const token = bearerToken(req);
      const gateway = token ? gatewayByToken(token) : null;
      if (!gateway) return json({ error: "invalid gateway token" }, 401);
      return await fn(req, { gateway });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

/** Wrap a public handler so thrown errors become JSON. Mutations must still come from the same origin. */
export function withPublic<P = Record<string, never>>(fn: (req: Request, ctx: { params: P }) => Promise<Response> | Response) {
  return async (req: Request, ctx?: { params: Promise<P> }): Promise<Response> => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403);
      const params = (ctx ? await ctx.params : {}) as P;
      return await fn(req, { params });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

// ---------------------------------------------------------------------------
// A small in-memory limiter for public endpoints (enrol, invite pickup).

const buckets = new Map<string, { count: number; windowStart: number; windowMs: number }>();
const MAX_BUCKETS = 50_000;

export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t - b.windowStart > windowMs) {
    buckets.delete(key);
    b = { count: 0, windowStart: t, windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (buckets.size > MAX_BUCKETS) evictBuckets(t);
  return b.count > max;
}

/**
 * Drops finished windows, then (if an attacker with many addresses still
 * fills the table) the oldest windows first. Clearing everything would hand
 * every address a fresh allowance.
 */
function evictBuckets(t: number): void {
  for (const [k, v] of buckets) if (t - v.windowStart > v.windowMs) buckets.delete(k);
  for (const k of buckets.keys()) {
    if (buckets.size <= MAX_BUCKETS * 0.9) break;
    buckets.delete(k);
  }
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}
