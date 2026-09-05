/**
 * Admin authentication: one local account, argon2id, server-side sessions
 * stored hashed, idle + absolute timeouts, failure-only throttling.
 */
import argon2 from "argon2";
import { eq, lt } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { randomId, randomToken, sha256Hex } from "@/core/crypto";
import { env, now } from "./env";
import { logEvent } from "./events";
import { getSettings, markSetupComplete } from "./settings";

export const SESSION_COOKIE = "opnmesh_session";
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status = 401,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Throttling: only failures count, so nobody can lock the admin out by
// hammering the login form with junk. Per-source buckets plus a global cap.

interface Bucket {
  failures: number;
  windowStart: number;
}
const buckets = new Map<string, Bucket>();
let globalBucket: Bucket = { failures: 0, windowStart: 0 };
const WINDOW_MS = 15 * 60 * 1000;
const PER_SOURCE_MAX = 10;
const GLOBAL_MAX = 100;

function bucketFor(key: string): Bucket {
  const t = now();
  let b = buckets.get(key);
  if (!b || t - b.windowStart > WINDOW_MS) {
    b = { failures: 0, windowStart: t };
    buckets.set(key, b);
  }
  if (t - globalBucket.windowStart > WINDOW_MS) globalBucket = { failures: 0, windowStart: t };
  return b;
}

export function loginThrottled(source: string): boolean {
  const b = bucketFor(source);
  return b.failures >= PER_SOURCE_MAX || globalBucket.failures >= GLOBAL_MAX;
}

function recordFailure(source: string): void {
  bucketFor(source).failures++;
  globalBucket.failures++;
}

export function resetThrottleForTests(): void {
  buckets.clear();
  globalBucket = { failures: 0, windowStart: 0 };
}

// ---------------------------------------------------------------------------
// Setup code: printed to the log on first start; required to create the admin.

const g = globalThis as unknown as { __opnmeshSetupCode?: string };

/**
 * The first-run setup code. Persisted in the data directory so it survives a
 * restart and is the same for every server process; letters and digits only
 * so it is easy to read out and to grep from a log.
 */
export function setupCode(): string {
  if (g.__opnmeshSetupCode) return g.__opnmeshSetupCode;
  const file = join(env().dataDir, "setup-code");
  let code = "";
  try {
    code = readFileSync(file, "utf8").trim();
  } catch {
    /* none yet */
  }
  if (!/^[A-Z0-9]{12}$/.test(code)) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(12);
    code = Array.from(bytes, (b) => alphabet[b % alphabet.length]!).join("");
    try {
      mkdirSync(env().dataDir, { recursive: true });
      writeFileSync(file, code + "\n", { mode: 0o600 });
    } catch {
      /* read-only data dir: the in-memory code still works for this process */
    }
  }
  g.__opnmeshSetupCode = code;
  return code;
}

export function needsSetup(): boolean {
  return !getSettings().setupComplete || getDb().select().from(users).all().length === 0;
}

export async function completeSetup(input: { code: string; email: string; password: string }, source = "unknown"): Promise<void> {
  if (!needsSetup()) throw new AuthError("setup already completed", 409);
  if (loginThrottled(source)) throw new AuthError("too many attempts — wait 15 minutes", 429);
  if (input.code.trim().toUpperCase() !== setupCode()) {
    recordFailure(source);
    throw new AuthError("setup code does not match the one printed in the controller log", 403);
  }
  validateCredentials(input.email, input.password);
  const hash = await argon2.hash(input.password, { type: argon2.argon2id });
  getDb().insert(users).values({ id: randomId(), email: input.email.trim(), passwordHash: hash, createdAt: now() }).run();
  markSetupComplete();
  logEvent("setup", `Admin account ${input.email.trim()} created`, { actor: input.email.trim() });
}

function validateCredentials(email: string, password: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new AuthError("enter a valid email address", 400);
  if (password.length < 12) throw new AuthError("password must be at least 12 characters", 400);
  if (password.length > 200) throw new AuthError("password is too long", 400);
}

export async function login(email: string, password: string, source = "unknown"): Promise<string> {
  if (loginThrottled(source)) throw new AuthError("too many failed attempts — wait 15 minutes", 429);
  const user = getDb().select().from(users).where(eq(users.email, email.trim())).get();
  const ok = user ? await argon2.verify(user.passwordHash, password) : false;
  if (!user || !ok) {
    recordFailure(source);
    // Constant-ish time: hashing a dummy when the user is unknown.
    if (!user) await argon2.hash("x".repeat(16), { type: argon2.argon2id });
    throw new AuthError("email or password is incorrect");
  }
  const token = randomToken();
  const t = now();
  getDb()
    .insert(sessions)
    .values({ id: sha256Hex(token), userId: user.id, createdAt: t, lastSeenAt: t, expiresAt: t + SESSION_ABSOLUTE_MS })
    .run();
  logEvent("login", `${user.email} signed in`, { actor: user.email });
  return token;
}

export async function changePassword(userId: string, current: string, next: string): Promise<void> {
  const user = getDb().select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new AuthError("no such user", 404);
  if (!(await argon2.verify(user.passwordHash, current))) throw new AuthError("current password is incorrect", 403);
  validateCredentials(user.email, next);
  getDb()
    .update(users)
    .set({ passwordHash: await argon2.hash(next, { type: argon2.argon2id }) })
    .where(eq(users.id, userId))
    .run();
  // Every other session dies with the old password.
  getDb().delete(sessions).where(eq(sessions.userId, userId)).run();
  logEvent("login", `${user.email} changed their password`, { actor: user.email });
}

export interface AdminSession {
  userId: string;
  email: string;
  sessionId: string;
}

export function sessionFromToken(token: string | null | undefined): AdminSession | null {
  if (!token) return null;
  const id = sha256Hex(token);
  const s = getDb().select().from(sessions).where(eq(sessions.id, id)).get();
  if (!s) return null;
  const t = now();
  if (t > s.expiresAt || t - s.lastSeenAt > SESSION_IDLE_MS) {
    getDb().delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }
  if (t - s.lastSeenAt > 60_000) getDb().update(sessions).set({ lastSeenAt: t }).where(eq(sessions.id, id)).run();
  const user = getDb().select().from(users).where(eq(users.id, s.userId)).get();
  if (!user) return null;
  return { userId: user.id, email: user.email, sessionId: id };
}

export function logout(token: string | null | undefined): void {
  if (!token) return;
  getDb().delete(sessions).where(eq(sessions.id, sha256Hex(token))).run();
}

export function pruneSessions(): number {
  return getDb().delete(sessions).where(lt(sessions.expiresAt, now())).run().changes;
}

/** Read the session cookie from a Request. */
export function tokenFromRequest(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionCookie(token: string | null): string {
  const secure = env().publicUrl.startsWith("https://") ? "; Secure" : "";
  if (token === null) return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_ABSOLUTE_MS / 1000)}${secure}`;
}

/** Best-effort client identity for throttling. Only trusts proxies when told to. */
export function requestSource(req: Request): string {
  if (env().trustProxy) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
  }
  return "direct";
}
