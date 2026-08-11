/**
 * End-to-end form flows through the real Next server actions.
 *
 * The earlier smoke tests only checked that pages *render*, which missed a
 * whole class of failure: a security header that made browsers send
 * `Origin: null` broke every form in the app while every page still looked
 * fine. These tests submit the actual forms the way a browser does, including
 * the Origin header, so setup and sign-in are exercised for real.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env["RUN_UI_TESTS"] === "1";
const PORT = 3988;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "correct-horse-battery-staple";

let server: ChildProcess | null = null;
let stateDir = "";
let dataDir = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The hidden field name Next uses to route a form post to its server action. */
async function actionIdOf(path: string): Promise<string> {
  const html = await (await fetch(`${BASE}${path}`)).text();
  const m = html.match(/name="(\$ACTION_ID_[a-f0-9]+)"/);
  if (!m) throw new Error(`no server action found on ${path}`);
  return m[1]!;
}

/** Submit a form the way a browser does, Origin header included. */
async function submit(
  path: string,
  fields: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  const fd = new FormData();
  fd.set(await actionIdOf(path), "");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const headers: Record<string, string> = { Origin: BASE };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${BASE}${path}`, { method: "POST", body: fd, headers, redirect: "manual" });
}

function sessionCookieFrom(res: Response): string | null {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    if (c.includes("opnmesh_session=")) return c.split(";")[0]!;
  }
  return null;
}

describe.skipIf(!enabled)("UI form flows", () => {
  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "opnmesh-flow-state-"));
    dataDir = mkdtempSync(join(tmpdir(), "opnmesh-flow-data-"));
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
        OPNMESH_CONTROL_URL: "http://127.0.0.1:9",
        OPNMESH_PROM_URL: "http://127.0.0.1:9",
        OPNMESH_ADMIN_TOKEN: "t".repeat(64),
        OPNMESH_ALLOW_INSECURE_HTTP: "1",
      },
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`${BASE}/setup`);
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
        /* already gone */
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("a form post with a normal browser Origin is accepted, not a 500", async () => {
    // Guards the exact regression: a security header that nulls the Origin
    // makes Next's CSRF check throw, and the user sees a blank page.
    const res = await submit("/setup", { token: "wrong", password: PASSWORD, confirm: PASSWORD });
    expect(res.status, "server action must not 500 on a normal form post").not.toBe(500);
    expect([200, 303, 307]).toContain(res.status);
  }, 30_000);

  it("setup rejects a wrong code, then accepts the real one and signs you in", async () => {
    const wrong = await submit("/setup", { token: "not-the-code", password: PASSWORD, confirm: PASSWORD });
    expect(wrong.status).toBe(303);
    expect(wrong.headers.get("location") ?? "").toContain("not%20valid");

    // Mismatched confirmation is caught before anything is written.
    const mismatch = await submit("/setup", { token: "x", password: PASSWORD, confirm: "different" });
    expect(mismatch.headers.get("location") ?? "").toContain("do%20not%20match");

    // Too short is refused.
    const short = await submit("/setup", { token: "x", password: "short", confirm: "short" });
    expect(short.headers.get("location") ?? "").toContain("12%20characters");

    // The real bootstrap token, printed to the server log on first render.
    const token = readFileSync(join(dataDir, "bootstrap-token"), "utf8").trim();
    const ok = await submit("/setup", { token, password: PASSWORD, confirm: PASSWORD });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/");
    const cookie = sessionCookieFrom(ok);
    expect(cookie, "setup must sign the new admin in").not.toBeNull();

    // That session really works.
    const dash = await fetch(`${BASE}/`, { headers: { cookie: cookie! }, redirect: "manual" });
    expect(dash.status).toBe(200);
    expect(await dash.text()).toContain("Force-directed diagram");
  }, 60_000);

  it("setup is closed once an admin exists — the page itself is unreachable", async () => {
    // The strongest form of "cannot be used twice": /setup no longer serves a
    // form at all, so a second account cannot be created even with the token.
    const page = await fetch(`${BASE}/setup`, { redirect: "manual" });
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/login");
    // Signing in still works, so this is the setup door closing rather than
    // the account being broken.
    const good = await submit("/login", { password: PASSWORD });
    expect(good.headers.get("location")).toBe("/");
  }, 30_000);

  it("sign-in works with the right password and refuses the wrong one", async () => {
    const bad = await submit("/login", { password: "definitely-wrong-password" });
    expect(bad.status).toBe(303);
    expect(bad.headers.get("location")).toContain("failed=1");

    const good = await submit("/login", { password: PASSWORD });
    expect(good.status).toBe(303);
    expect(good.headers.get("location")).toBe("/");
    const cookie = sessionCookieFrom(good);
    expect(cookie).not.toBeNull();

    const nodes = await fetch(`${BASE}/nodes`, { headers: { cookie: cookie! }, redirect: "manual" });
    expect(nodes.status).toBe(200);
  }, 60_000);

  it("repeated wrong passwords are throttled, and the message says so", async () => {
    for (let i = 0; i < 6; i++) await submit("/login", { password: `wrong-${i}-password` });
    const throttled = await submit("/login", { password: "wrong-again-password" });
    expect(throttled.headers.get("location")).toContain("throttled=1");
    const page = await (await fetch(`${BASE}/login?throttled=1`)).text();
    expect(page).toContain("Too many failed attempts");
  }, 60_000);
});
