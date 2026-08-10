/**
 * UI authentication: a single local admin account, argon2id password hash,
 * HTTP-only Secure SameSite=Strict session cookie backed by a server-side
 * session table in SQLite, with idle and absolute timeouts.
 *
 * Hardening notes, each guarding a specific failure:
 *  - Session tokens are stored HASHED. Read access to ui.db (a backup, a
 *    stray volume mount) must not hand over live sessions.
 *  - Login throttling is per source address and only counts FAILURES, so an
 *    attacker cannot lock the single admin out of their own panel during an
 *    incident — the thing they would most want to do first.
 *  - Changing the password invalidates every existing session.
 *  - First-run setup is gated by a one-time bootstrap token printed to the
 *    server log, so whoever reaches the port first cannot claim the panel.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import argon2 from "argon2";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { DATA_DIR } from "./env.js";

const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h idle
const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7d absolute
/** __Host- forces Secure + path=/ + no Domain, i.e. no subdomain injection. */
const COOKIE = "__Host-opnmesh_session";
/** Fallback name for plain-HTTP lab use, where __Host- cookies are rejected. */
const COOKIE_INSECURE = "opnmesh_session";
const MIN_PASSWORD_LENGTH = 12;
const FAILURES_BEFORE_THROTTLE = 5;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Cookies must be Secure in production. The one exception is an explicitly
 * flagged insecure lab run, which also downgrades the cookie name because
 * browsers reject __Host- cookies without Secure.
 */
const INSECURE_COOKIES = process.env["OPNMESH_ALLOW_INSECURE_HTTP"] === "1";
const cookieName = INSECURE_COOKIES ? COOKIE_INSECURE : COOKIE;

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(join(DATA_DIR, "ui.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_failures (source TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS login_failures_ts ON login_failures (ts);
  `);
  return db;
}

const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export function adminConfigured(): boolean {
  return getDb().prepare("SELECT 1 FROM admin WHERE id = 1").get() !== undefined;
}

/**
 * Bootstrap token for first-run setup. Generated once and written to the data
 * directory; the operator reads it from the server log or the file. Without
 * it, an attacker who reaches the port before the operator cannot create the
 * admin account.
 */
export function bootstrapToken(): string {
  const path = join(DATA_DIR, "bootstrap-token");
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const token = randomBytes(24).toString("hex");
  writeFileSync(path, token + "\n", { encoding: "utf8", mode: 0o600 });
  console.log(
    `\n  OPNmesh first-run setup token: ${token}\n` +
      `  Enter it at /setup to create the admin account.\n`,
  );
  return token;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function verifyBootstrapToken(presented: string): boolean {
  return constantTimeEquals(presented, bootstrapToken());
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (/^(.)\1*$/.test(password)) return "Password must not be a single repeated character.";
  return null;
}

/** Creates or replaces the admin password and invalidates every session. */
export async function setAdminPassword(password: string): Promise<void> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const d = getDb();
  d.transaction(() => {
    d.prepare(
      "INSERT INTO admin (id, password_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET password_hash = ?",
    ).run(hash, hash);
    // A password change revokes existing sessions — otherwise a stolen
    // session survives the very action taken to stop it.
    d.prepare("DELETE FROM sessions").run();
  })();
}

/** Creates the admin account exactly once; a second attempt fails. */
export async function createAdminAccount(password: string, token: string): Promise<boolean> {
  if (!verifyBootstrapToken(token)) return false;
  if (adminConfigured()) return false;
  await setAdminPassword(password);
  return true;
}

async function sourceAddress(): Promise<string> {
  const h = await headers();
  // Behind a reverse proxy the first XFF hop is the client.
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip") ?? "local";
}

function throttled(source: string): boolean {
  const d = getDb();
  const cutoff = Date.now() - THROTTLE_WINDOW_MS;
  d.prepare("DELETE FROM login_failures WHERE ts < ?").run(cutoff);
  const row = d.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE source = ?").get(source) as {
    n: number;
  };
  return row.n >= FAILURES_BEFORE_THROTTLE;
}

export interface LoginResult {
  ok: boolean;
  throttled: boolean;
}

export async function login(password: string): Promise<LoginResult> {
  const d = getDb();
  const source = await sourceAddress();
  if (throttled(source)) return { ok: false, throttled: true };

  const row = d.prepare("SELECT password_hash FROM admin WHERE id = 1").get() as
    | { password_hash: string }
    | undefined;
  const valid = row !== undefined && (await argon2.verify(row.password_hash, password));
  if (!valid) {
    d.prepare("INSERT INTO login_failures (source, ts) VALUES (?, ?)").run(source, Date.now());
    return { ok: false, throttled: false };
  }

  // Success clears this source's failures so a legitimate admin is never
  // locked out by someone else's guessing.
  d.prepare("DELETE FROM login_failures WHERE source = ?").run(source);

  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  d.prepare("INSERT INTO sessions (token_hash, created_at, last_seen) VALUES (?, ?, ?)").run(
    hashToken(token),
    now,
    now,
  );
  const jar = await cookies();
  jar.set(cookieName, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: !INSECURE_COOKIES,
    path: "/",
    maxAge: ABSOLUTE_TIMEOUT_MS / 1000,
  });
  return { ok: true, throttled: false };
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  if (token) getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  jar.delete(cookieName);
}

async function validSession(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  if (!token) return false;
  const d = getDb();
  const tokenHash = hashToken(token);
  const row = d.prepare("SELECT created_at, last_seen FROM sessions WHERE token_hash = ?").get(tokenHash) as
    | { created_at: number; last_seen: number }
    | undefined;
  if (!row) return false;
  const now = Date.now();
  if (now - row.created_at > ABSOLUTE_TIMEOUT_MS || now - row.last_seen > IDLE_TIMEOUT_MS) {
    d.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return false;
  }
  d.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").run(now, tokenHash);
  return true;
}

/** Call at the top of every page, server action and route handler. */
export async function requireAdmin(): Promise<void> {
  if (!adminConfigured()) redirect("/setup");
  if (!(await validSession())) redirect("/login");
}
