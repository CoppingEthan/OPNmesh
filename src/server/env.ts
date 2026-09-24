/**
 * Process configuration. Everything comes from the environment with a
 * default; the sealing secret is generated once into the data directory if
 * not supplied, so a bare `docker compose up` works and the secret survives
 * restarts.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface Env {
  dataDir: string;
  publicUrl: string;
  secret: string;
  insecureHttp: boolean;
  /** How many reverse proxies sit in front of the controller (0 = none, trust no forwarding headers). */
  trustProxy: number;
}

const g = globalThis as unknown as { __opnmeshEnv?: Env };

export function env(): Env {
  if (g.__opnmeshEnv) return g.__opnmeshEnv;
  const dataDir = process.env["OPNMESH_DATA_DIR"] ?? "./data";
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dataDir, 0o700); // the database and secret.key are for this process only
  } catch {
    /* not ours to change (a read-only or foreign mount): leave it */
  }
  g.__opnmeshEnv = {
    dataDir,
    publicUrl: (process.env["OPNMESH_PUBLIC_URL"] ?? "http://localhost:3000").replace(/\/+$/, ""),
    secret: loadSecret(dataDir),
    insecureHttp: process.env["OPNMESH_INSECURE_HTTP"] === "1",
    trustProxy: proxyHops(process.env["OPNMESH_TRUST_PROXY"]),
  };
  return g.__opnmeshEnv;
}

const MIN_SECRET_LENGTH = 32;

/**
 * The sealing secret: OPNMESH_SECRET, or data/secret.key, created on first
 * start. Everything sealed with it (client keys, UniFi and SMTP passwords) is
 * unreadable under any other value, so a missing or damaged key file next to
 * an existing database stops the controller instead of being replaced.
 */
function loadSecret(dataDir: string): string {
  const fromEnv = process.env["OPNMESH_SECRET"]?.trim() ?? "";
  if (fromEnv) {
    if (fromEnv.length < MIN_SECRET_LENGTH) throw new Error(`OPNMESH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    return fromEnv;
  }
  const file = join(dataDir, "secret.key");
  if (existsSync(file)) {
    const secret = readFileSync(file, "utf8").trim();
    if (secret.length < MIN_SECRET_LENGTH) throw new Error(`${file} is empty or damaged. Restore it from your backup: without it the stored keys and passwords cannot be read.`);
    return secret;
  }
  const db = process.env["OPNMESH_DB_PATH"] ?? join(dataDir, "opnmesh.db");
  if (existsSync(db)) {
    throw new Error(`${file} is missing but the database ${db} exists. Restore secret.key from your backup (or set OPNMESH_SECRET to the value it held).`);
  }
  const secret = randomBytes(32).toString("hex");
  writeFileAtomic(file, secret + "\n", 0o600);
  return secret;
}

/**
 * Write, fsync, rename, then fsync the directory so the new name is on disk
 * before anything is sealed with the key. The temporary name is random: in
 * the container the process id is always 1, so a name built from it and left
 * behind by a crash would stop every later start.
 */
function writeFileAtomic(file: string, content: string, mode: number): void {
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, file);
  fsyncDir(dirname(file));
}

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* Windows cannot open a directory to sync it (development only) */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** OPNMESH_TRUST_PROXY: a count of proxies; anything that is not a small whole number means none. */
export function proxyHops(value: string | undefined): number {
  const n = Number((value ?? "").trim());
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 0;
}

/** Tests: override the cached environment. */
export function setEnvForTests(partial: Partial<Env>): void {
  g.__opnmeshEnv = { ...env(), ...partial };
}

export const now = (): number => Date.now();

/**
 * Controller version, shown in the status bar. The image build sets
 * OPNMESH_VERSION from the release tag; a development checkout shows the
 * placeholder.
 */
export const APP_VERSION = process.env["OPNMESH_VERSION"]?.trim() || "2.0.0-dev";
