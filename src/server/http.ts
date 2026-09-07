/**
 * Route-handler plumbing: JSON responses, body validation, error mapping,
 * and the two authentication wrappers (admin session, gateway token).
 */
import { z, type ZodType } from "zod";
import { AuthError, sessionFromToken, tokenFromRequest, type AdminSession } from "./auth";
import { ClientError } from "./clients";
import { SettingsError } from "./settings";
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

const MAX_BODY = 1 << 20;

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) throw new HttpError(413, "body too large");
  let raw: unknown;
  try {
    const textBody = await req.text();
    if (textBody.length > MAX_BODY) throw new HttpError(413, "body too large");
    raw = textBody.length === 0 ? {} : JSON.parse(textBody);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "body must be JSON");
  }
  return schema.parse(raw);
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin fetches and non-browser clients omit it
  try {
    const o = new URL(origin);
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    return o.host === host;
  } catch {
    return false;
  }
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

const buckets = new Map<string, { count: number; windowStart: number }>();

export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t - b.windowStart > windowMs) {
    b = { count: 0, windowStart: t };
    buckets.set(key, b);
  }
  b.count++;
  if (buckets.size > 10_000) buckets.clear();
  return b.count > max;
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}
