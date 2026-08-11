/**
 * UI smoke test: boots the BUILT Next.js app (npm run ui:test handles the
 * build) against a throwaway state dir seeded with the reference fixture and
 * no control server (pages must degrade gracefully). Verifies the auth gate,
 * session handling, and that every page renders its content.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startNextServer, stopNextServer, type RunningServer } from "./helpers/next-server.js";

const enabled = process.env["RUN_UI_TESTS"] === "1";
const PORT = 3987;
// 127.0.0.1 explicitly: `localhost` can resolve dual-stack under vitest and
// flake on redirect follows.
const BASE = `http://127.0.0.1:${PORT}`;

let server: RunningServer | null = null;
let stateDir = "";
let dataDir = "";
let sessionToken = "";

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

    server = await startNextServer(PORT, {
      OPNMESH_STATE_DIR: stateDir,
      OPNMESH_DATA_DIR: dataDir,
      // Unreachable on purpose: the UI must render without the control server.
      OPNMESH_CONTROL_URL: "http://127.0.0.1:9",
      OPNMESH_PROM_URL: "http://127.0.0.1:9",
      OPNMESH_ADMIN_TOKEN: "t".repeat(64),
      // Plain HTTP under test, so cookies drop the __Host- prefix.
      OPNMESH_ALLOW_INSECURE_HTTP: "1",
    });
  }, 120_000);

  afterAll(async () => {
    await stopNextServer(server);
    // One test opens ui.db in this process; Windows will not unlink a file
    // that still has a handle.
    try {
      const { closeDb } = await import("../lib/ui/auth.js");
      closeDb();
    } catch {
      /* module never loaded */
    }
    // Best effort: a leftover temp directory is harmless, and failing the
    // suite over it would hide the real result.
    for (const dir of [stateDir, dataDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS will reap it */
      }
    }
  }, 30_000);

  it("first run redirects to setup; after admin exists, to login", async () => {
    const res = await get("/");
    expect(res.url).toContain("/setup");
    expect(await res.text()).toContain("Welcome to OPNmesh");

    // Configure the admin out-of-band (same SQLite the server uses).
    process.env["OPNMESH_DATA_DIR"] = dataDir;
    const { setAdminPassword } = await import("../lib/ui/auth.js");
    await setAdminPassword("correct-horse-battery-staple");

    const after = await get("/");
    expect(after.url).toContain("/login");
    expect(await after.text()).toContain("Sign in");
  }, 30_000);

  it("a valid server-side session unlocks the dashboard", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { createHash } = await import("node:crypto");
    const db = new Database(join(dataDir, "ui.db"));
    sessionToken = randomBytes(32).toString("hex");
    const now = Date.now();
    // Sessions are stored hashed, so insert the hash the server will look up.
    const hash = createHash("sha256").update(sessionToken, "utf8").digest("hex");
    db.prepare("INSERT INTO sessions (token_hash, created_at, last_seen) VALUES (?, ?, ?)").run(hash, now, now);
    db.close();

    const res = await get("/");
    const html = await res.text();
    expect(res.url).not.toContain("/login");
    // The control server is unreachable in this test, so the honest headline
    // is that nothing has checked in — stated in plain language, not jargon.
    expect(html).toContain("Waiting for your first location to connect");
    expect(html).toContain("Site A");
    expect(html).toContain("How your locations reach each other");
    // Topology is known from sites.yml even with no live data.
    expect(html).toContain("connects directly");
    // The diagram renders from config alone.
    expect(html).toContain("Force-directed diagram");
  }, 30_000);

  it("feature pages render with config-derived content, control server down", async () => {
    const checks: Array<[string, string]> = [
      ["/nodes", "Issue one-time token"],
      ["/", "Force-directed diagram"],
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
