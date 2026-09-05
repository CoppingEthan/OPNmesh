/**
 * Helpers for driving the simulation: docker compose exec, the controller's
 * HTTP API from the host, and polling with deadlines.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const API = "http://127.0.0.1:18080";
const COMPOSE = ["compose", "-f", resolve("sim/docker-compose.yml")];

export interface ExecResult {
  code: number;
  out: string;
}

/** Run a shell command inside a simulation container. */
export function exec(service: string, command: string, opts: { timeoutMs?: number } = {}): ExecResult {
  const r = spawnSync("docker", [...COMPOSE, "exec", "-T", service, "sh", "-c", command], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 60_000,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Start a long-running command in a container and return immediately. */
export function execDetached(service: string, command: string): void {
  const r = spawnSync("docker", [...COMPOSE, "exec", "-d", service, "sh", "-c", command], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`exec -d ${service}: ${command}\n${r.stdout}${r.stderr}`);
}

export function mustExec(service: string, command: string, opts: { timeoutMs?: number } = {}): string {
  const r = exec(service, command, opts);
  if (r.code !== 0) throw new Error(`exec ${service}: ${command}\n${r.out}`);
  return r.out;
}

export function compose(args: string[], opts: { timeoutMs?: number } = {}): string {
  const r = spawnSync("docker", [...COMPOSE, ...args], { encoding: "utf8", timeout: opts.timeoutMs ?? 120_000 });
  if (r.status !== 0) throw new Error(`docker compose ${args.join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

export function writeState(relPath: string, content: string): void {
  const p = resolve("sim/state", relPath);
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

/** ping -c N from a container; true when at least one reply arrived. */
export function ping(service: string, target: string, count = 3): boolean {
  return exec(service, `ping -c ${count} -W 2 ${target} >/dev/null 2>&1`, { timeoutMs: 30_000 }).code === 0;
}

/** curl with a hard timeout; returns the HTTP status or 0 on failure. */
export function httpStatus(service: string, url: string, timeoutS = 8): number {
  const r = exec(service, `curl -s -o /dev/null -w '%{http_code}' --max-time ${timeoutS} ${url}`, { timeoutMs: (timeoutS + 5) * 1000 });
  const n = Number(r.out.trim());
  return Number.isFinite(n) ? n : 0;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      lastErr = e;
    }
    await sleep(opts.intervalMs ?? 2000);
  }
  throw new Error(`timed out waiting for ${label}${lastErr ? `: ${String(lastErr)}` : ""}`);
}

// --- controller API ---------------------------------------------------------

let cookie = "";
export function setCookie(c: string): void {
  cookie = c;
}
export function getCookie(): string {
  return cookie;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
  const attempt = () =>
    fetch(API + path, {
      method,
      // Fresh connection per call: a pooled keep-alive socket the server has
      // since closed surfaces as "other side closed" and is not worth a retry loop.
      headers: { "content-type": "application/json", connection: "close", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  let res: Response;
  try {
    res = await attempt();
  } catch (e) {
    if (!(e instanceof TypeError)) throw e; // only transport failures are retried
    await sleep(500);
    res = await attempt();
  }
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

export async function must<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await api<T>(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

export function setupCodeFromLogs(): string | null {
  const logs = compose(["logs", "--no-color", "controller"]);
  const matches = [...logs.matchAll(/setup code:\s+([A-Z0-9]{12})\b/g)];
  const last = matches[matches.length - 1];
  return last ? last[1]! : null;
}
