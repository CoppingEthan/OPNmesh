#!/usr/bin/env node
/**
 * UI smoke test: start the production build against a throwaway data
 * directory, complete first-run setup through the API, and load every page
 * as a signed-in admin, checking each renders its key content.
 *
 *   npm run build && node scripts/ui-smoke.mjs
 *
 * With --standalone it runs .next/standalone/server.js instead of `next
 * start` (after copying static assets, public/ and the gateway installer
 * beside it, as the Dockerfile does), so CI exercises what the image runs.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "opnmesh-smoke-"));

const standalone = process.argv.includes("--standalone");
if (standalone) {
  cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
  cpSync("public", ".next/standalone/public", { recursive: true });
  mkdirSync(".next/standalone/deploy/gateway", { recursive: true });
  cpSync("deploy/gateway/install.sh", ".next/standalone/deploy/gateway/install.sh");
}
const env = { ...process.env, OPNMESH_DATA_DIR: dataDir, OPNMESH_PUBLIC_URL: BASE, OPNMESH_INSECURE_HTTP: "1", NODE_ENV: "production" };
const server = standalone
  ? spawn(process.execPath, [".next/standalone/server.js"], { env: { ...env, PORT: String(PORT), HOSTNAME: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] })
  : spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? "  ok " : " FAIL"} ${msg}`);
  if (!ok) failed = true;
};

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/api/admin/setup`)).ok;
    } catch {
      /* not yet */
    }
  }
  check(up, "server started");
  if (!up) throw new Error(`server did not start:\n${log}`);

  const html = async (path, cookie = "") => {
    const r = await fetch(BASE + path, { headers: cookie ? { cookie } : {}, redirect: "manual" });
    return { status: r.status, location: r.headers.get("location"), text: r.status === 200 ? await r.text() : "" };
  };

  // Unauthenticated: setup page renders, app pages redirect to setup.
  const setup = await html("/setup");
  check(setup.status === 200 && setup.text.includes("Welcome to OPNmesh"), "/setup renders the first-run form");
  const home0 = await html("/");
  check(home0.status === 307 && home0.location?.endsWith("/setup"), "/ redirects to /setup before setup");

  let code = "";
  for (let i = 0; i < 20 && !code; i++) {
    try {
      code = readFileSync(join(dataDir, "setup-code"), "utf8").trim();
    } catch {
      await sleep(250);
    }
  }
  check(/^[A-Z0-9]{12}$/.test(code), "setup code persisted in the data directory");
  const r = await fetch(`${BASE}/api/admin/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, email: "smoke@example.com", password: "smoke test password" }) });
  check(r.status === 200, "first-run setup through the API");
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];

  const login = await html("/login");
  check(login.status === 200 && login.text.includes("Sign in"), "/login renders");
  const home1 = await html("/", cookie);
  check(home1.status === 200 && home1.text.includes("Start by adding a site"), "/ renders the empty-state overview");

  // Seed some data through the API and check every page.
  const j = (m, p, b) => fetch(BASE + p, { method: m, headers: { "content-type": "application/json", cookie }, body: b ? JSON.stringify(b) : undefined }).then((x) => x.json());
  const site = await j("POST", "/api/admin/sites", { name: "Datacentre", hubPriority: 1 });
  await j("POST", `/api/admin/sites/${site.id}/lans`, { cidr: "10.0.1.0/24", name: "Servers" });
  const client = await j("POST", "/api/admin/clients", { name: "Smoke laptop" });

  const pages = [
    ["/", "Datacentre"],
    ["/sites", "Datacentre"],
    [`/sites/${site.id}`, "Generate install command"],
    ["/clients", "Smoke laptop"],
    [`/clients/${client.id}`, "Hand it over"],
    ["/traffic", "Traffic"],
    ["/events", "Datacentre&quot; created"],
    ["/settings", "Network"],
  ];
  for (const [path, needle] of pages) {
    const p = await html(path, cookie);
    check(p.status === 200 && p.text.includes(needle), `${path} renders (${needle})`);
  }
  const inv = await j("POST", `/api/admin/clients/${client.id}/invite`, {});
  const invitePage = await html(new URL(inv.url).pathname);
  check(invitePage.status === 200 && invitePage.text.includes("OPN"), "/invite/<token> renders publicly");
  const missing = await html("/sites/nope", cookie);
  check(missing.status === 404, "unknown site is a 404");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  server.kill();
  await sleep(500);
  rmSync(dataDir, { recursive: true, force: true });
}
if (failed) {
  console.error("\nUI smoke test FAILED. Server log:\n" + log.slice(-4000));
  process.exit(1);
}
console.log("\nUI smoke test passed.");
