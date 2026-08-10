/**
 * UI authentication (per the project's approved decision): a single local
 * admin account, argon2id password hash, HTTP-only Secure SameSite=Strict
 * session cookie backed by a server-side session table in SQLite, with idle
 * and absolute timeouts and rate-limited login.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import argon2 from "argon2";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DATA_DIR } from "./env.js";

const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h idle
const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7d absolute
const COOKIE = "opnmesh_session";

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(join(DATA_DIR, "ui.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (ts INTEGER NOT NULL);
  `);
  return db;
}

export function adminConfigured(): boolean {
  return getDb().prepare("SELECT 1 FROM admin WHERE id = 1").get() !== undefined;
}

export async function setAdminPassword(password: string): Promise<void> {
  if (password.length < 10) throw new Error("password must be at least 10 characters");
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  getDb()
    .prepare("INSERT INTO admin (id, password_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET password_hash = ?")
    .run(hash, hash);
}

function loginRateLimited(): boolean {
  const d = getDb();
  const cutoff = Date.now() - 15 * 60 * 1000;
  d.prepare("DELETE FROM login_attempts WHERE ts < ?").run(cutoff);
  const row = d.prepare("SELECT COUNT(*) AS n FROM login_attempts").get() as { n: number };
  return row.n >= 10;
}

export async function login(password: string): Promise<boolean> {
  const d = getDb();
  if (loginRateLimited()) return false;
  d.prepare("INSERT INTO login_attempts (ts) VALUES (?)").run(Date.now());
  const row = d.prepare("SELECT password_hash FROM admin WHERE id = 1").get() as
    | { password_hash: string }
    | undefined;
  if (!row) return false;
  if (!(await argon2.verify(row.password_hash, password))) return false;

  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  d.prepare("INSERT INTO sessions (token, created_at, last_seen) VALUES (?, ?, ?)").run(token, now, now);
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ABSOLUTE_TIMEOUT_MS / 1000,
  });
  return true;
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
  jar.delete(COOKIE);
}

async function validSession(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return false;
  const d = getDb();
  const row = d.prepare("SELECT created_at, last_seen FROM sessions WHERE token = ?").get(token) as
    | { created_at: number; last_seen: number }
    | undefined;
  if (!row) return false;
  const now = Date.now();
  if (now - row.created_at > ABSOLUTE_TIMEOUT_MS || now - row.last_seen > IDLE_TIMEOUT_MS) {
    d.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return false;
  }
  d.prepare("UPDATE sessions SET last_seen = ? WHERE token = ?").run(now, token);
  return true;
}

/** Call at the top of every page and server action. Redirects when not authed. */
export async function requireAdmin(): Promise<void> {
  if (!adminConfigured()) redirect("/setup");
  if (!(await validSession())) redirect("/login");
}
