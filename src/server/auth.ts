/**
 * Admin authentication: one local account, argon2id, server-side sessions
 * stored hashed, idle + absolute timeouts, failure-only throttling.
 */
import argon2 from "argon2";
import { eq, lt } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isIPv6 } from "node:net";
import { join } from "node:path";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { macTag, randomId, randomToken, sha256Hex } from "@/core/crypto";
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
// Throttling. Each attempt is charged before the password is checked and
// given back when it proves right, so concurrent guesses cannot overrun the
// limit while argon2 is busy. Attempts are counted per client (an IPv6 client
// by its /64) with a global cap on top against a distributed guess. A browser
// that has signed in before carries a signed device cookie and is counted on
// its own, outside the global cap, so junk from elsewhere cannot lock the
// admin out of a browser they already use.

interface Bucket {
  failures: number;
  windowStart: number;
}
const buckets = new Map<string, Bucket>();
let globalBucket: Bucket = { failures: 0, windowStart: 0 };
const WINDOW_MS = 15 * 60 * 1000;
const PER_SOURCE_MAX = 10;
const GLOBAL_MAX = 100;
const MAX_TRACKED = 50_000;

/** Who an attempt is charged to, and whether it also counts towards the global cap. */
export interface Attempt {
  key: string;
  global: boolean;
}

/** The throttling identity of a client address: an IPv6 address by its /64, since one host usually holds the whole prefix. */
export function throttleKey(source: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(source);
  if (mapped) return mapped[1]!;
  if (!isIPv6(source)) return source;
  const lower = source.toLowerCase();
  const [head = "", tail = ""] = lower.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = lower.includes("::") ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return groups
    .slice(0, 4)
    .map((part) => part.replace(/^0+(?=.)/, ""))
    .join(":") + "::/64";
}

export function attemptFor(source: string, device: string | null = null): Attempt {
  return device ? { key: `device:${device}`, global: false } : { key: `source:${throttleKey(source)}`, global: true };
}

function bucket(key: string): Bucket {
  const t = now();
  let b = buckets.get(key);
  if (!b || t - b.windowStart > WINDOW_MS) {
    buckets.delete(key);
    b = { failures: 0, windowStart: t };
    buckets.set(key, b);
    if (buckets.size > MAX_TRACKED) pruneBuckets(t);
  }
  if (t - globalBucket.windowStart > WINDOW_MS) globalBucket = { failures: 0, windowStart: t };
  return b;
}

/** Finished windows first; then, if many addresses still fill the table, the oldest. */
function pruneBuckets(t: number): void {
  for (const [k, v] of buckets) if (t - v.windowStart > WINDOW_MS) buckets.delete(k);
  for (const k of buckets.keys()) {
    if (buckets.size <= MAX_TRACKED * 0.9) break;
    buckets.delete(k);
  }
}

function throttled(a: Attempt): boolean {
  const b = bucket(a.key);
  return b.failures >= PER_SOURCE_MAX || (a.global && globalBucket.failures >= GLOBAL_MAX);
}

function charge(a: Attempt): void {
  bucket(a.key).failures++;
  if (a.global) globalBucket.failures++;
}

function refund(a: Attempt): void {
  const b = bucket(a.key);
  b.failures = Math.max(0, b.failures - 1);
  if (a.global) globalBucket.failures = Math.max(0, globalBucket.failures - 1);
}

export function loginThrottled(source: string, device: string | null = null): boolean {
  return throttled(attemptFor(source, device));
}

export function resetThrottleForTests(): void {
  buckets.clear();
  globalBucket = { failures: 0, windowStart: 0 };
}

// ---------------------------------------------------------------------------
// Device cookie: set on every successful sign-in and sent only to the sign-in
// endpoint. It holds a random id and a MAC made with the server secret, so it
// cannot be forged, and it grants nothing but its own throttling bucket.

export const DEVICE_COOKIE = "opnmesh_device";
const DEVICE_MAX_AGE_S = 400 * 24 * 60 * 60; // the longest browsers keep a cookie

export function deviceCookie(existing: string | null): string {
  const id = existing ?? randomToken().slice(0, 22);
  const secure = env().publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${DEVICE_COOKIE}=${id}.${macTag(id, env().secret, "device")}; Path=/api/admin/login; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_MAX_AGE_S}${secure}`;
}

/** The device id from a valid device cookie, or null. */
export function deviceFromRequest(req: Request): string | null {
  const m = /^([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{32})$/.exec(cookieValue(req, DEVICE_COOKIE) ?? "");
  if (!m) return null;
  const expected = Buffer.from(macTag(m[1]!, env().secret, "device"));
  const given = Buffer.from(m[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given) ? m[1]! : null;
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

function codesEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/**
 * Creates the one admin account. The setup code has 60 bits, so the
 * per-client limit alone stops guessing; there is no global cap here, which
 * would let anyone stop the owner finishing setup.
 */
export async function completeSetup(input: { code: string; email: string; password: string }, source = "unknown"): Promise<void> {
  if (!needsSetup()) throw new AuthError("setup already completed", 409);
  const attempt: Attempt = { key: `setup:${throttleKey(source)}`, global: false };
  if (throttled(attempt)) throw new AuthError("too many attempts — wait 15 minutes", 429);
  if (!codesEqual(input.code.trim().toUpperCase(), setupCode())) {
    charge(attempt);
    logEvent("login", `Failed first-run setup attempt from ${source}`, { actor: "anonymous", detail: { attempted: safeActor(input.email) } });
    throw new AuthError("setup code does not match the one printed in the controller log", 403);
  }
  validateCredentials(input.email, input.password);
  const hash = await argon2.hash(input.password, { type: argon2.argon2id });
  // Checked again after the await, in one transaction: two requests holding the code must not both create an admin.
  getDb().transaction((tx) => {
    if (!needsSetup()) throw new AuthError("setup already completed", 409);
    tx.insert(users).values({ id: randomId(), email: input.email.trim(), passwordHash: hash, createdAt: now() }).run();
    markSetupComplete();
  });
  // The code has done its job; a later reset (see README) makes a new one.
  g.__opnmeshSetupCode = undefined;
  rmSync(join(env().dataDir, "setup-code"), { force: true });
  logEvent("setup", `Admin account ${input.email.trim()} created`, { actor: input.email.trim() });
}

/** An attempted identity as it may be written to the log: printable, bounded. */
function safeActor(email: string): string {
  const s = email.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
  return s === "" ? "(empty)" : s;
}

function validateCredentials(email: string, password: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new AuthError("enter a valid email address", 400);
  if (password.length < 12) throw new AuthError("password must be at least 12 characters", 400);
  if (password.length > 200) throw new AuthError("password is too long", 400);
}

export async function login(email: string, password: string, source = "unknown", device: string | null = null): Promise<string> {
  const attempt = attemptFor(source, device);
  if (throttled(attempt)) throw new AuthError("too many failed attempts — wait 15 minutes", 429);
  charge(attempt);
  const user = getDb().select().from(users).where(eq(users.email, email.trim())).get();
  let ok = false;
  if (user) ok = await argon2.verify(user.passwordHash, password);
  else await argon2.hash("x".repeat(16), { type: argon2.argon2id }); // the same work as a real check
  if (!user || !ok) {
    logEvent("login", `Failed sign-in from ${source}`, { actor: "anonymous", detail: { attempted: safeActor(email) } });
    throw new AuthError("email or password is incorrect");
  }
  refund(attempt);
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
  // A stolen session must not become a way to guess the password.
  const attempt: Attempt = { key: `password:${userId}`, global: false };
  if (throttled(attempt)) throw new AuthError("too many failed attempts — wait 15 minutes", 429);
  charge(attempt);
  if (!(await argon2.verify(user.passwordHash, current))) throw new AuthError("current password is incorrect", 403);
  refund(attempt);
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

function cookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Read the session cookie from a Request. */
export function tokenFromRequest(req: Request): string | null {
  return cookieValue(req, SESSION_COOKIE);
}

export function sessionCookie(token: string | null): string {
  const secure = env().publicUrl.startsWith("https://") ? "; Secure" : "";
  if (token === null) return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_ABSOLUTE_MS / 1000)}${secure}`;
}

/**
 * Best-effort client identity for throttling and the audit log. With
 * OPNMESH_TRUST_PROXY=N (N reverse proxies in front), the client is the Nth
 * X-Forwarded-For address counted from the right: each proxy adds the address
 * it received the request from, and everything further left came from the
 * client and can be forged. A proxy that adds its own header line rather than
 * appending is handled the same way, because repeated headers are joined in
 * order. Without a configured proxy the header is ignored.
 */
export function requestSource(req: Request): string {
  const hops = env().trustProxy;
  if (hops > 0) {
    const chain = (req.headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const client = chain[Math.max(0, chain.length - hops)];
    if (client) return client;
  }
  return "direct";
}
