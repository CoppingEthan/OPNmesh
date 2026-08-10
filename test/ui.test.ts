/**
 * UI smoke test: boots the BUILT Next.js app (npm run ui:test handles the
 * build) against a throwaway state dir seeded with the reference fixture and
 * no control server (pages must degrade gracefully). Verifies the auth gate,
 * session handling, and that every page renders its content.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const enabled = process.env["RUN_UI_TESTS"] === "1";
const PORT = 3987;
// 127.0.0.1 explicitly: `localhost` can resolve dual-stack under vitest and
// flake on redirect follows.
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;
let stateDir = "";
let dataDir = "";
let sessionToken = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(path: string, redirect: "follow" | "manual" = "follow"): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      redirect,
      headers: sessionToken ? { cookie: `opnmesh_session=${sessionToken}` } : {},
    });
  } catch (e: any) {
    throw new Error(`fetch ${path} failed: ${e?.cause?.message ?? e?.message} (${JSON.stringify(e?.cause ?? {})})`);
  }
}

describe.skipIf(!enabled)("UI (phase 7)", () => {
  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "opnmesh-ui-state-"));
    dataDir = mkdtempSync(join(tmpdir(), "opnmesh-ui-data-"));
    cpSync(join(process.cwd(), "test", "fixtures", "reference.yml"), join(stateDir, "sites.yml"));
    mkdirSync(join(stateDir, "control"), { recursive: true });

    server = spawn("npx", ["next", "start", "-p", String(PORT)], {
      cwd: process.cwd(),
      shell: true,
      stdio: "ignore",
      env: {
        ...process.env,
        OPNMESH_STATE_DIR: stateDir,
        OPNMESH_DATA_DIR: dataDir,
        // Unreachable on purpose: the UI must render without the control server.
        OPNMESH_CONTROL_URL: "http://127.0.0.1:9",
        OPNMESH_PROM_URL: "http://127.0.0.1:9",
      },
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`${BASE}/login`);
        return;
      } catch {
        await sleep(1000);
      }
    }
    throw new Error("next start did not come up");
  }, 90_000);

  afterAll(() => {
    if (server?.pid) {
      try {
        process.kill(server.pid);
        spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { shell: true });
      } catch {
        /* gone */
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("first run redirects to setup; after admin exists, to login", async () => {
    const res = await get("/");
    expect(res.url).toContain("/setup");
    expect(await res.text()).toContain("create the admin account");

    // Configure the admin out-of-band (same SQLite the server uses).
    process.env["OPNMESH_DATA_DIR"] = dataDir;
    const { setAdminPassword } = await import("../lib/ui/auth.js");
    await setAdminPassword("correct-horse-battery");

    const after = await get("/");
    expect(after.url).toContain("/login");
    expect(await after.text()).toContain("Sign in");
  }, 30_000);

  it("a valid server-side session unlocks the dashboard", async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(join(dataDir, "ui.db"));
    sessionToken = randomBytes(32).toString("hex");
    const now = Date.now();
    db.prepare("INSERT INTO sessions (token, created_at, last_seen) VALUES (?, ?, ?)").run(sessionToken, now, now);
    db.close();

    const res = await get("/");
    const html = await res.text();
    expect(res.url).not.toContain("/login");
    expect(html).toContain("Mesh overview");
    expect(html).toContain("site-a");
    expect(html).toContain("Connectivity matrix");
    // Full mesh: all pairs direct.
    expect(html).toContain("direct");
  }, 30_000);

  it("feature pages render with config-derived content, control server down", async () => {
    const checks: Array<[string, string]> = [
      ["/nodes", "Issue one-time token"],
      ["/clients", "Entry points (preference order)"],
      ["/config", "wg0.conf"],
      ["/routes", "UniFi"],
      ["/updates", "Start a rollout"],
      ["/alerts", "Send test email"],
      ["/settings", "private"],
      ["/traffic", "only sees traffic that crosses a tunnel"],
    ];
    for (const [path, marker] of checks) {
      const res = await get(path);
      const html = await res.text();
      expect(res.status, path).toBe(200);
      expect(html, `${path} missing "${marker}"`).toContain(marker);
    }
  }, 60_000);

  it("routes page uses actual configured ports and the clients page carries no private key", async () => {
    const routes = await (await get("/routes")).text();
    expect(routes).toContain("Forward UDP port 51820");
    const clients = await (await get("/clients")).text();
    expect(clients).toContain("{{CLIENT_PRIVATE_KEY}}");
    expect(clients).not.toMatch(/PrivateKey = [A-Za-z0-9+/]{43}=/);
  }, 30_000);

  it("logout-equivalent: an invalid session bounces back to login", async () => {
    sessionToken = "0".repeat(64);
    const res = await get("/");
    expect(res.url).toContain("/login");
    sessionToken = "";
  }, 30_000);
});
