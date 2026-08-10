/**
 * Shared helpers for integration tests against the live simulation.
 * The management API requires the admin credential, so tests read the same
 * token the simulation generated.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONTROL = "http://localhost:18080";

export function adminToken(): string {
  return readFileSync(join(process.cwd(), "docker", "state", "control", "admin.token"), "utf8").trim();
}

export function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${adminToken()}`, ...extra };
}

/** Authenticated fetch against the control server, with retries for restarts. */
export async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      return await fetch(`${CONTROL}${path}`, {
        ...init,
        headers: adminHeaders((init.headers as Record<string, string>) ?? {}),
      });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

export async function adminJson<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await adminFetch(path, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
