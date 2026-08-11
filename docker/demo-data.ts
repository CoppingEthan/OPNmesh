/**
 * Populate the running simulation with a realistic dataset, so every page in
 * the UI has something meaningful on it.
 *
 * Everything here goes through the real code paths — config is validated and
 * generated the same way, the fourth site enrols with a one-time token and is
 * approved like any other, the release is genuinely built and signed, and the
 * traffic is real packets crossing real tunnels. Nothing is faked into the
 * database.
 *
 * Safe to re-run: steps that are already done are skipped.
 *
 *   npm run mesh:demo        (requires npm run mesh:up first)
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadSitesYaml } from "../lib/schema.js";
import { generateAll } from "../lib/generator/index.js";
import { runValidators } from "../lib/validators/index.js";
import { wgKeypair } from "./simkeys.js";

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = join(here, "state");
const SITES = join(stateDir, "sites.yml");
const CONTROL = process.env["OPNMESH_CONTROL_URL"] ?? "http://localhost:18080";
// Quoted: the repo path can contain spaces.
const COMPOSE = `docker compose -f "${join(here, "docker-compose.yml")}"`;

const sh = (cmd: string, env: Record<string, string> = {}): string =>
  execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
    env: { ...process.env, ...env },
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (msg: string) => console.log(`\n▸ ${msg}`);

function adminToken(): string {
  return readFileSync(join(stateDir, "control", "admin.token"), "utf8").trim();
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken()}` },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${CONTROL}${path}`, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null) return v;
    } catch {
      /* retry */
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Write sites.yml only if it passes the full schema + validator pipeline. */
function saveSites(doc: unknown): void {
  const text = stringifyYaml(doc);
  const cfg = loadSitesYaml(text);
  const errors = runValidators(cfg, generateAll(cfg)).filter((f) => f.level === "error");
  if (errors.length > 0) {
    console.error("refusing to write invalid configuration:");
    for (const e of errors) console.error(`  - ${e.message}`);
    process.exit(1);
  }
  writeFileSync(SITES, text, "utf8");
}

if (!existsSync(SITES)) {
  console.error("no simulation state found — run `npm run mesh:up` first");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Give the existing sites realistic names and VLANs.
//
// The docker networks are 10.10/16, 10.20/16 and 10.30/16, so the first VLAN
// at each site keeps that range (it is where the gateway and LAN hosts really
// live) and the extra segments use adjacent ranges. Site B stays a single flat
// network on purpose — a small site should look simple.
// ---------------------------------------------------------------------------
step("naming sites and adding VLANs");
const doc = parseYaml(readFileSync(SITES, "utf8"));

const siteA = doc.sites.find((s: any) => s.id === "site-a");
siteA.name = "Head Office";
siteA.gateway.name = "Head Office Gateway";
delete siteA.lan;
siteA.lans = [
  { cidr: "10.10.0.0/16", name: "Staff", vlan: 10 },
  { cidr: "10.11.20.0/24", name: "Voice", vlan: 20 },
  { cidr: "10.11.30.0/24", name: "CCTV", vlan: 30 },
  { cidr: "10.11.99.0/24", name: "Management", vlan: 99, role: "management" },
  // Guest ranges are never routed, so the same range at two sites is fine.
  { cidr: "192.168.10.0/24", name: "Guest Wi-Fi", vlan: 90, role: "guest" },
];

const siteB = doc.sites.find((s: any) => s.id === "site-b");
siteB.name = "Branch Office";
siteB.gateway.name = "Branch Gateway";

const siteC = doc.sites.find((s: any) => s.id === "site-c");
siteC.name = "Warehouse";
siteC.gateway.name = "Warehouse Gateway";
delete siteC.lan;
siteC.lans = [
  { cidr: "10.30.0.0/16", name: "Office", vlan: 10 },
  { cidr: "10.31.40.0/24", name: "Barcode scanners", vlan: 40 },
  { cidr: "10.31.99.0/24", name: "Management", vlan: 99, role: "management" },
  { cidr: "192.168.10.0/24", name: "Guest Wi-Fi", vlan: 90, role: "guest" },
];

// Only the IT subnet may reach any management VLAN; the management VLANs
// themselves are added to the destination set automatically by their role.
doc.policy = { management: { admin_sources: ["10.10.5.0/24"], management_destinations: [] } };

// ---------------------------------------------------------------------------
// 2. A few more roaming devices. Only "laptop" has a container behind it, so
//    the others will correctly show as configured-but-not-connected.
// ---------------------------------------------------------------------------
step("adding roaming devices");
doc.clients[0].name = "Field Laptop";
const extraClients = [
  { id: "ops-phone", name: "Ops Phone", tunnel_ip: "10.99.1.11", home_site: "site-b" },
  {
    id: "warehouse-tablet",
    name: "Warehouse Tablet",
    tunnel_ip: "10.99.1.12",
    home_site: "site-c",
    entry_points: ["site-c", "site-a"],
  },
];
for (const c of extraClients) {
  if (doc.clients.some((x: any) => x.id === c.id)) continue;
  doc.clients.push({ ...c, public_key: wgKeypair().publicKey });
}

saveSites(doc);
console.log("  sites.yml updated and validated");

// ---------------------------------------------------------------------------
// 3. Turn on per-host flow records so the Traffic page has top talkers.
// ---------------------------------------------------------------------------
step("enabling per-host flow records");
const withFlows = parseYaml(readFileSync(SITES, "utf8"));
for (const s of withFlows.sites) s.gateway.flows = true;
saveSites(withFlows);
console.log("  flows on at every gateway");

// ---------------------------------------------------------------------------
// 4. Start the traffic generator and observability stack.
// ---------------------------------------------------------------------------
step("starting traffic generator and observability stack");
sh(`${COMPOSE} --profile traffic up -d traffic-gen`);
sh(`${COMPOSE} --profile obs up -d prometheus alertmanager grafana mailpit`);
console.log("  Prometheus :19090 · Grafana :13000 · Alertmanager :19093 · Mailpit :18025");

// ---------------------------------------------------------------------------
// 5. Enrol a fourth site through the real one-time-token flow.
// ---------------------------------------------------------------------------
const alreadyFour = (parseYaml(readFileSync(SITES, "utf8")).sites as any[]).some((s) => s.id === "site-d");
if (alreadyFour) {
  step("fourth site already enrolled — skipping");
} else {
  step("enrolling a fourth site (real token → pending → approval)");
  const issued = await api<{ token: string }>("POST", "/api/v1/admin/enrol-tokens", {
    role: "gateway",
    note: "Remote Depot",
  });
  if (issued.status !== 200) throw new Error(`could not issue token: ${JSON.stringify(issued.body)}`);

  sh(`${COMPOSE} --profile enrol up -d gw-d host-d`, { ENROL_TOKEN: issued.body.token });
  const pending = await waitFor(
    async () => {
      const { body } = await api<{ pending: any[] }>("GET", "/api/v1/admin/pending");
      // Newest first: a container that was recreated leaves older pending
      // entries behind, and approving one of those binds a token no live
      // node holds.
      const mine = body.pending
        .filter((p) => p.hostname === "gw-d")
        .sort((a, b) => b.enrolledAt - a.enrolledAt);
      return mine[0] ?? null;
    },
    90_000,
    "the new gateway to enrol",
  );
  console.log(`  pending, key fingerprint ${pending.fingerprint}`);

  const approved = await api("POST", "/api/v1/admin/approve", {
    pendingId: pending.id,
    site: {
      id: "site-d",
      name: "Remote Depot",
      lan: "10.40.0.0/16",
      gateway: {
        name: "Depot Gateway",
        lan_ip: "10.40.0.2",
        tunnel_ip: "10.99.0.4",
        endpoint: "198.51.100.40",
      },
    },
  });
  if (approved.status !== 200) throw new Error(`approval failed: ${JSON.stringify(approved.body)}`);
  console.log("  approved and joining the mesh");
}

// ---------------------------------------------------------------------------
// 6. Build, sign and roll out a release.
//
// The signing key must reach every node BEFORE the rollout: an agent with no
// /etc/opnmesh/minisign.pub refuses all updates (fail closed, by design). The
// bind-mounted gateways get it from build-release; a freshly enrolled node has
// no mount, so it is copied in the way a real installer ships it.
// ---------------------------------------------------------------------------
const versions = async (): Promise<Record<string, string>> => {
  const { body } = await api<{ nodes: Record<string, { version: string }> }>("GET", "/api/v1/state");
  return Object.fromEntries(Object.entries(body.nodes).map(([k, v]) => [k, v.version]));
};

const TARGET = "1.4.0";
const current = await versions();
if (Object.values(current).every((v) => v === TARGET)) {
  step(`every gateway already runs ${TARGET} — skipping rollout`);
} else {
  step(`building and signing release ${TARGET}`);
  sh(`npx tsx "${join(here, "build-release.ts")}" --version ${TARGET}`, {
    OPNMESH_ADMIN_TOKEN: adminToken(),
  });

  step("distributing the release signing key to every gateway");
  const pub = join(stateDir, "control", "minisign", "key.pub");
  for (const id of Object.keys(current)) {
    const container = `opnmesh-gw-${id.replace("site-", "")}`;
    try {
      sh(`docker cp "${pub}" ${container}:/etc/opnmesh/minisign.pub`);
      console.log(`  ${container}`);
    } catch {
      console.log(`  ${container} — skipped (not a simulation container)`);
    }
  }

  step(`rolling out ${TARGET}: canary first, one node at a time`);
  // Clear any previous attempt so this starts from a clean state machine.
  await api("POST", "/api/v1/admin/rollout/cancel");
  const created = await api("POST", "/api/v1/admin/rollout", {
    version: TARGET,
    canary: "site-b",
    soakSec: 10,
    failTimeoutSec: 240,
  });
  if (created.status !== 200) throw new Error(`rollout failed to start: ${JSON.stringify(created.body)}`);

  const outcome = await waitFor(
    async () => {
      const { body } = await api<{ rollout: { status: string; abortReason?: string } | null }>(
        "GET",
        "/api/v1/admin/rollout",
      );
      const st = body.rollout?.status;
      return st === "done" || st === "aborted" ? body.rollout! : null;
    },
    360_000,
    "the staged rollout to finish",
  );
  if (outcome.status === "aborted") {
    throw new Error(`rollout aborted: ${outcome.abortReason}`);
  }
  console.log(`  every gateway is on ${TARGET}`);
}

// ---------------------------------------------------------------------------
// 7. Wait for the mesh to settle, then take a packet capture.
// ---------------------------------------------------------------------------
step("waiting for every gateway to report healthy");
const converged = await waitFor(
  async () => {
    const { body } = await api<{ nodes: Record<string, any> }>("GET", "/api/v1/state");
    const ids = Object.keys(body.nodes);
    const ok = ids.filter((id) => body.nodes[id].lastSeen && !body.nodes[id].drift);
    return ok.length === ids.length && ids.length > 0 ? ids : null;
  },
  180_000,
  "all gateways healthy",
);
console.log(`  ${converged.length} gateways reporting: ${converged.join(", ")}`);

step("running a packet capture on the head office gateway");
const cap = await api<{ id: string }>("POST", "/api/v1/admin/capture", {
  node: "site-a",
  filter: "icmp or tcp port 5201",
  seconds: 10,
  maxKb: 1024,
});
if (cap.status === 200) console.log(`  capture ${cap.body.id} queued — downloadable from the Traffic page`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const finalState = await api<{ nodes: Record<string, any>; rates: Record<string, any> }>("GET", "/api/v1/state");
const finalCfg = loadSitesYaml(readFileSync(SITES, "utf8"));
const vlanCount = finalCfg.sites.reduce((n, s) => n + s.lans.length, 0);

console.log(`
Done. The simulation now has:
  ${finalCfg.sites.length} locations, ${vlanCount} networks/VLANs between them
  ${finalCfg.clients.length} roaming devices (1 actually connected)
  ${Object.keys(finalState.body.nodes ?? {}).length} gateways reporting in
  live traffic on ${Object.keys(finalState.body.rates ?? {}).length} links
  flow records, a packet capture, and a completed release rollout

Open the dashboard at http://localhost:3000
`);
