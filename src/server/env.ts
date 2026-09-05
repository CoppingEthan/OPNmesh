/**
 * Process configuration. Everything comes from the environment with a
 * default; the sealing secret is generated once into the data directory if
 * not supplied, so a bare `docker compose up` works and the secret survives
 * restarts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface Env {
  dataDir: string;
  publicUrl: string;
  secret: string;
  insecureHttp: boolean;
  trustProxy: boolean;
}

const g = globalThis as unknown as { __opnmeshEnv?: Env };

export function env(): Env {
  if (g.__opnmeshEnv) return g.__opnmeshEnv;
  const dataDir = process.env["OPNMESH_DATA_DIR"] ?? "./data";
  mkdirSync(dataDir, { recursive: true });
  let secret = process.env["OPNMESH_SECRET"] ?? "";
  if (!secret) {
    const file = join(dataDir, "secret.key");
    if (existsSync(file)) secret = readFileSync(file, "utf8").trim();
    if (!secret) {
      secret = randomBytes(32).toString("hex");
      writeFileSync(file, secret + "\n", { mode: 0o600 });
    }
  }
  g.__opnmeshEnv = {
    dataDir,
    publicUrl: (process.env["OPNMESH_PUBLIC_URL"] ?? "http://localhost:3000").replace(/\/+$/, ""),
    secret,
    insecureHttp: process.env["OPNMESH_INSECURE_HTTP"] === "1",
    trustProxy: process.env["OPNMESH_TRUST_PROXY"] === "1",
  };
  return g.__opnmeshEnv;
}

/** Tests: override the cached environment. */
export function setEnvForTests(partial: Partial<Env>): void {
  g.__opnmeshEnv = { ...env(), ...partial };
}

export const now = (): number => Date.now();

/** Controller version, shown in the status bar and reported in events. */
export const APP_VERSION = "2.0.0-dev";
