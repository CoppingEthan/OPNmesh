#!/usr/bin/env node
/**
 * Build a populated demo on top of the four-site simulation: four sites with
 * their real layouts, four enrolled gateways, the router changes OPNmesh's
 * own Router page prints, and a roaming client that is connected. The LAN
 * hosts already generate day-like traffic, so once the tunnels are up the
 * dashboard moves on its own.
 *
 *   npm run sim:down && npm run sim:up     # gateways only enrol on a clean state
 *   node scripts/demo.mjs
 *
 * This is the integration suite's happy path without the assertions or the
 * disruptive cases (it never stops the controller, reboots a gateway or
 * restricts the client), so it leaves the mesh in the state you would want to
 * show someone. Re-running it against an already-built demo is fine: it
 * deletes the sites first and rebuilds them, but the gateways keep their
 * enrolment, so `sim:down && sim:up` first if you want a truly fresh one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const API = "http://127.0.0.1:18080";
const COMPOSE = ["compose", "-f", resolve("sim/docker-compose.yml")];
const EMAIL = "admin@example.com";
const PASSWORD = "simulation password 1";

// The simulation's addressing, mirroring sim/docker-compose.yml.
const SITES = [
  { key: "a", name: "Datacentre", layout: "transit", prio: 1, cidr: "10.0.1.0/24", lan: "Servers", gwIp: "10.0.250.2", endpoint: "198.51.100.10" },
  { key: "b", name: "Office", layout: "same_lan", prio: 2, cidr: "192.168.20.0/24", lan: "Staff", gwIp: "192.168.20.2", endpoint: "198.51.100.20" },
  { key: "c", name: "Warehouse", layout: "masquerade", prio: 3, cidr: "10.30.0.0/24", lan: "Warehouse", gwIp: "10.30.0.2", endpoint: null },
  { key: "d", name: "Shop", layout: "transit", prio: 4, cidr: "10.40.0.0/24", lan: "Shop floor", gwIp: "10.40.250.2", endpoint: null },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`\n[1;36m==>[0m ${msg}`);
const note = (msg) => console.log(`    ${msg}`);

function compose(args, { allowFail = false } = {}) {
  const r = spawnSync("docker", [...COMPOSE, ...args], { encoding: "utf8", timeout: 120_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && !allowFail) throw new Error(`docker compose ${args.join(" ")} failed:\n${out}`);
  return out;
}

/** Run a command inside a simulation container. */
function exec(service, command, opts = {}) {
  return compose(["exec", "-T", service, "sh", "-c", command], opts);
}

let cookie = "";
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", connection: "close", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}
async function must(method, path, body) {
  const r = await api(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function waitFor(label, fn, { timeoutMs = 120_000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

const state = () => must("GET", "/api/admin/state");

function setupCodeFromLogs() {
  const logs = compose(["logs", "--no-color", "controller"], { allowFail: true });
  const m = [...logs.matchAll(/setup code:\s+([A-Z0-9]{12})\b/g)];
  return m.length ? m[m.length - 1][1] : null;
}

function writeState(rel, content) {
  const p = resolve("sim/state", rel);
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

/** Apply exactly what the site's Router page prints, to that site's router. */
function applyRouterPlan(site, plan) {
  const router = `router-${site.key}`;
  let applied = 0;
  for (const r of plan.routes) {
    if (!r.required) continue;
    exec(router, `ip route replace ${r.cidr} via ${plan.nextHop}`);
    applied++;
  }
  if (plan.allStatesPolicy) {
    // The same-LAN layout needs the all-states rule, or TCP hangs while ping works.
    const already = exec(router, `nft -a list chain inet router forward | grep -c opnmesh-policy || true`).trim();
    if (already === "0") {
      const prefix = site.gwIp.split(".").slice(0, 3).join(".");
      const lanIf = exec(router, `ip -o -4 addr show | awk '$4 ~ "^${prefix}" {print $2; exit}'`).trim();
      const dests = plan.allStatesPolicy.destinations.join(", ");
      exec(router, `nft insert rule inet router forward iifname "${lanIf}" ip daddr { ${dests} } accept comment "opnmesh-policy"`);
      note(`${router}: all-states firewall policy added (same-LAN layout)`);
    }
  }
  note(`${router}: ${applied} static route${applied === 1 ? "" : "s"} applied`);
}

async function main() {
  step("Waiting for the simulation's controller");
  await waitFor("controller API", async () => (await api("GET", "/api/admin/setup")).status === 200, { timeoutMs: 180_000, intervalMs: 2000 });

  step("Signing in");
  const needs = await must("GET", "/api/admin/setup");
  if (needs.needsSetup) {
    const code = await waitFor("setup code in the controller log", () => setupCodeFromLogs(), { timeoutMs: 60_000, intervalMs: 2000 });
    const r = await api("POST", "/api/admin/setup", { code, email: EMAIL, password: PASSWORD });
    if (r.status !== 200) throw new Error(`setup failed: ${JSON.stringify(r.body)}`);
    cookie = r.headers.get("set-cookie").split(";")[0];
    note(`admin created: ${EMAIL}`);
  } else {
    const r = await api("POST", "/api/admin/login", { email: EMAIL, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
    cookie = r.headers.get("set-cookie").split(";")[0];
    note(`signed in as ${EMAIL}`);
  }

  step("Creating the four sites and their networks");
  for (const s of await must("GET", "/api/admin/sites")) await must("DELETE", `/api/admin/sites/${s.id}`);
  for (const s of SITES) {
    const site = await must("POST", "/api/admin/sites", { name: s.name, routerLayout: s.layout, hubPriority: s.prio });
    await must("POST", `/api/admin/sites/${site.id}/lans`, { cidr: s.cidr, name: s.lan });
    s.id = site.id;
    note(`${s.name}: ${s.cidr} (${s.layout})`);
  }

  step("Enrolling the gateways");
  for (const s of SITES) {
    const tok = await must("POST", `/api/admin/sites/${s.id}/enrol-token`, {});
    writeState(`gw-${s.key}/enrol.token`, tok.token + "\n");
  }
  note("tokens delivered; the gateway VMs run the real installer against them");
  await waitFor(
    "all four gateways online",
    async () => (await state()).sites.filter((x) => x.gateway?.health === "online").length === 4,
    { timeoutMs: 240_000 },
  );
  note("four gateways online");

  step("Setting which sites accept incoming tunnels");
  for (const s of SITES.filter((x) => x.endpoint)) {
    await must("PATCH", `/api/admin/sites/${s.id}/gateway`, { endpointHost: s.endpoint });
    note(`${s.name} accepts connections at ${s.endpoint}`);
  }
  note("Warehouse and Shop dial out only, so Shop reaches Warehouse through the Datacentre");
  await waitFor(
    "gateways applied the topology",
    async () => {
      const st = await state();
      const gws = st.sites.filter((x) => x.gateway).map((x) => x.gateway);
      return gws.length === 4 && gws.every((g) => g.health === "online" && g.configCurrent && !g.attention);
    },
    { timeoutMs: 180_000 },
  );

  step("Applying the router changes OPNmesh prints for each site");
  for (const s of SITES) {
    const { plan } = await must("GET", `/api/admin/sites/${s.id}/router`);
    applyRouterPlan(s, plan);
  }

  step("Adding a roaming client and connecting it");
  const client = await must("POST", "/api/admin/clients", { name: "Sim laptop", owner: "demo@example.com" });
  const conf = await api("GET", `/api/admin/clients/${client.id}/config`);
  if (conf.status !== 200) throw new Error(`client config: ${JSON.stringify(conf.body)}`);
  writeState("client/client.conf", conf.body);
  note("client config written; the client container brings the tunnel up");

  step("Waiting for the mesh to come up");
  const final = await waitFor(
    "every direct tunnel up",
    async () => {
      const st = await state();
      const direct = st.tunnels.filter((t) => t.kind === "direct");
      return direct.length === 5 && direct.every((t) => t.health === "up") ? st : null;
    },
    { timeoutMs: 180_000 },
  );
  await waitFor("client online", async () => (await state()).clients.some((c) => c.online), { timeoutMs: 120_000 }).catch(() =>
    note("client not shown online yet; it usually appears within a minute"),
  );
  // Adding the client changed the configuration, so the gateways are briefly
  // "not yet applied". Let that settle before reporting, or the summary below
  // says the sites need attention when they are seconds away from fine.
  const settled = await waitFor(
    "gateways applied the client",
    async () => {
      const st = await state();
      return st.sites.every((x) => x.gateway?.configCurrent && !x.gateway?.attention) ? st : null;
    },
    { timeoutMs: 90_000, intervalMs: 2000 },
  ).catch(() => null);
  if (settled) Object.assign(final, settled);

  console.log("\n" + "=".repeat(66));
  console.log("  OPNmesh demo is ready");
  console.log("=".repeat(66));
  console.log(`  Dashboard   ${API}`);
  console.log(`  Sign in     ${EMAIL}`);
  console.log(`  Password    ${PASSWORD}`);
  console.log("");
  console.log(`  ${final.sites.length} sites, ${final.tunnels.filter((t) => t.kind === "direct").length} direct tunnels, ` + `${final.tunnels.filter((t) => t.kind === "transit").length} relayed, 1 roaming client`);
  console.log(`  Headline    ${final.headline.title}`);
  console.log("");
  console.log("  The LAN hosts generate traffic continuously, so the map and the");
  console.log("  graphs move on their own. Try Sites > any site > Run checks.");
  console.log("=".repeat(66) + "\n");
}

if (!existsSync(resolve("sim/docker-compose.yml"))) {
  console.error("run this from the repository root");
  process.exit(2);
}
main().catch((e) => {
  console.error(`\ndemo setup failed: ${e.message}`);
  process.exit(1);
});
