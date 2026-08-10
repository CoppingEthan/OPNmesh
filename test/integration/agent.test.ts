/**
 * Phase-3 integration tests: agents polling the control server on the live
 * compose mesh. Covers check-in, idempotent reconcile (no writes, no flap),
 * config change propagation, port pre-flight refusal, local-drift healing,
 * and last-known-good behaviour across a control outage.
 *
 * The tests mutate docker/state/sites.yml (the control server's source of
 * truth, mounted into the container) and always restore it.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { wgKeypair } from "../../docker/simkeys.js";

const enabled = process.env["RUN_MESH_TESTS"] === "1";
const CONTROL = "http://localhost:18080";
const SITES_PATH = join(process.cwd(), "docker", "state", "sites.yml");
const POLL_MS = 3000;

const sh = (cmd: string): string =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
const exec = (c: string, cmd: string): string => sh(`docker exec ${c} sh -c "${cmd.replace(/"/g, '\\"')}"`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pingOk(from: string, toIp: string, attempts = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      exec(from, `ping -c 1 -W 2 ${toIp}`);
      return true;
    } catch {
      await sleep(1000);
    }
  }
  return false;
}

interface NodeState {
  desiredHash: string | null;
  lastSeen: number | null;
  appliedHash: string | null;
  diskHash: string | null;
  lastError: string;
  drift: boolean;
}

async function controlState(): Promise<Record<string, NodeState>> {
  const res = await fetch(`${CONTROL}/api/v1/state`);
  expect(res.ok).toBe(true);
  return ((await res.json()) as { nodes: Record<string, NodeState> }).nodes;
}

/** Poll until predicate holds on control state, or time out. */
async function waitForState(
  pred: (nodes: Record<string, NodeState>) => boolean,
  timeoutMs = 30_000,
): Promise<Record<string, NodeState>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, NodeState> = {};
  while (Date.now() < deadline) {
    try {
      last = await controlState();
      if (pred(last)) return last;
    } catch {
      /* control may be restarting */
    }
    await sleep(1000);
  }
  throw new Error(`state condition not met in ${timeoutMs}ms: ${JSON.stringify(last, null, 2)}`);
}

/**
 * Endpoint heal: after an uncoordinated port change reverts, a NAT'd-style
 * deadlock appears — a peer keeps dialling the stale port, and if its path to
 * the control node runs over that dead tunnel it can never fetch the fix
 * (§6's "naive implementation deadlocks", solved properly by phase-6
 * coordinated changes). Poking traffic from every gateway makes the reachable
 * side initiate, and WireGuard endpoint roaming updates the stale peers.
 */
function healEndpoints(): void {
  for (const gw of ["opnmesh-gw-a", "opnmesh-gw-b", "opnmesh-gw-c"]) {
    for (const ip of ["10.99.0.1", "10.99.0.2", "10.99.0.3"]) {
      try {
        exec(gw, `ping -c 1 -W 1 ${ip}`);
      } catch {
        /* best effort */
      }
    }
  }
}

/** Converge with periodic endpoint healing. */
async function waitConverged(timeoutMs = 60_000): Promise<Record<string, NodeState>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, NodeState> = {};
  while (Date.now() < deadline) {
    healEndpoints();
    try {
      last = await controlState();
      if (allConverged(last)) return last;
    } catch {
      /* control may be restarting */
    }
    await sleep(2000);
  }
  throw new Error(`mesh did not converge in ${timeoutMs}ms: ${JSON.stringify(last, null, 2)}`);
}

const allConverged = (nodes: Record<string, NodeState>) =>
  ["site-a", "site-b", "site-c"].every(
    (id) =>
      nodes[id] != null &&
      nodes[id]!.lastSeen != null &&
      !nodes[id]!.drift &&
      nodes[id]!.lastError === "" &&
      nodes[id]!.diskHash === nodes[id]!.desiredHash,
  );

function editSites(fn: (doc: any) => void): void {
  const doc = parseYaml(readFileSync(SITES_PATH, "utf8"));
  fn(doc);
  writeFileSync(SITES_PATH, stringifyYaml(doc), "utf8");
}

/** Highest latest-handshake per peer on a gateway; used for flap detection. */
function handshakes(container: string): Map<string, number> {
  const out = exec(container, "wg show wg0 latest-handshakes");
  return new Map(
    out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [key, ts] = l.split("\t");
        return [key!, Number(ts)] as const;
      }),
  );
}

function expectNoFlap(before: Map<string, number>, after: Map<string, number>): void {
  for (const [key, ts] of after) {
    const prev = before.get(key);
    if (prev && prev > 0) {
      expect(ts, `handshake for ${key} reset — tunnel flapped`).toBeGreaterThanOrEqual(prev);
    }
  }
}

let originalSites = "";

describe.skipIf(!enabled)("agent + pull API (phase 3)", () => {
  beforeAll(async () => {
    originalSites = readFileSync(SITES_PATH, "utf8");
    await waitConverged(90_000);
  }, 120_000);

  afterEach(async () => {
    // Restore truth and let the mesh settle back to converged.
    writeFileSync(SITES_PATH, originalSites, "utf8");
    await waitConverged(90_000);
  }, 120_000);

  afterAll(() => {
    writeFileSync(SITES_PATH, originalSites, "utf8");
    try {
      sh("docker start opnmesh-control");
    } catch {
      /* running */
    }
  });

  it("all gateways check in, converged, no drift, no errors", async () => {
    const nodes = await waitForState(allConverged);
    for (const id of ["site-a", "site-b", "site-c"]) {
      expect(nodes[id]!.appliedHash).toBe(nodes[id]!.desiredHash);
    }
  }, 60_000);

  it("unchanged config: no file writes, no tunnel restarts across polls", async () => {
    const mtimeBefore = exec("opnmesh-gw-a", "stat -c %Y /etc/opnmesh/wg0.conf").trim();
    const hsBefore = handshakes("opnmesh-gw-a");
    await sleep(POLL_MS * 3);
    const mtimeAfter = exec("opnmesh-gw-a", "stat -c %Y /etc/opnmesh/wg0.conf").trim();
    expect(mtimeAfter, "wg0.conf was rewritten despite no changes").toBe(mtimeBefore);
    expectNoFlap(hsBefore, handshakes("opnmesh-gw-a"));
  }, 60_000);

  it("adding a client propagates via syncconf without flapping existing tunnels", async () => {
    const kp = wgKeypair();
    const hsBefore = handshakes("opnmesh-gw-a");
    editSites((doc) => {
      doc.clients.push({
        id: "extra-client",
        tunnel_ip: "10.99.1.50",
        public_key: kp.publicKey,
        entry_points: ["site-a"],
        home_site: "site-a",
      });
    });
    await waitConverged(60_000);
    const peers = exec("opnmesh-gw-a", "wg show wg0 peers");
    expect(peers).toContain(kp.publicKey);
    expectNoFlap(hsBefore, handshakes("opnmesh-gw-a"));
    // Only site-a is an entry point, so gw-b routes the client via gw-a
    // rather than peering with it directly.
    const gwB = exec("opnmesh-gw-b", "cat /etc/opnmesh/wg0.conf");
    expect(gwB).toContain("10.99.1.50/32");
    expect(exec("opnmesh-gw-b", "wg show wg0 peers")).not.toContain(kp.publicKey);
  }, 90_000);

  it("an interface-level change (MTU) applies to the changed node only", async () => {
    const gwAHashBefore = (await controlState())["site-a"]!.desiredHash;
    editSites((doc) => {
      doc.sites.find((s: any) => s.id === "site-b").gateway.mtu = 1400;
    });
    await waitConverged(60_000);
    expect(exec("opnmesh-gw-b", "ip -o link show wg0")).toContain("mtu 1400");
    // site-a's desired config is untouched by a site-b interface-only change.
    expect((await controlState())["site-a"]!.desiredHash).toBe(gwAHashBefore);
  }, 90_000);

  it("agent refuses a config whose listen port is already bound, keeps serving traffic, reports the error", async () => {
    // Occupy the target port on gw-a first.
    sh(`docker exec -d opnmesh-gw-a nc -u -l 51877`);
    await sleep(500);
    editSites((doc) => {
      doc.sites.find((s: any) => s.id === "site-a").gateway.listen_port = 51877;
    });

    const nodes = await waitForState(
      (n) => (n["site-a"]?.lastError ?? "").includes("51877"),
      45_000,
    );
    expect(nodes["site-a"]!.lastError).toMatch(/port 51877 is already bound/);
    expect(nodes["site-a"]!.drift).toBe(true); // desired not applied, by design

    // The old config keeps running: port unchanged, cross-site traffic alive.
    expect(exec("opnmesh-gw-a", "wg show wg0 listen-port").trim()).toBe("51820");
    expect(await pingOk("opnmesh-host-a", "10.30.5.20")).toBe(true);

    // Free the port; the agent must now converge on the new port.
    try {
      sh("docker exec opnmesh-gw-a killall nc");
    } catch {
      /* nc already gone */
    }
    await waitConverged(60_000);
    expect(exec("opnmesh-gw-a", "wg show wg0 listen-port").trim()).toBe("51877");
  }, 120_000);

  it("local tampering is healed on the next poll", async () => {
    exec("opnmesh-gw-a", "echo '# tampered' >> /etc/opnmesh/wg0.conf");
    // Wait for a report submitted AFTER the tampering, so we are not fooled
    // by the pre-tamper converged state.
    const t0 = Date.now();
    const nodes = await waitForState(
      (n) => allConverged(n) && (n["site-a"]!.lastSeen ?? 0) > t0,
      30_000,
    );
    const conf = exec("opnmesh-gw-a", "cat /etc/opnmesh/wg0.conf");
    expect(conf).not.toContain("tampered");
    expect(nodes["site-a"]!.drift).toBe(false);
  }, 60_000);

  it("control outage: agents hold last known good; recovery reconciles without a flap", async () => {
    const hsBefore = handshakes("opnmesh-gw-a");
    sh("docker stop -t 1 opnmesh-control");
    try {
      await sleep(POLL_MS * 3); // several failed polls
      // Data plane unaffected.
      expect(await pingOk("opnmesh-host-a", "10.30.5.20")).toBe(true);
      expect(await pingOk("opnmesh-client", "10.20.5.20")).toBe(true);
      // Config untouched.
      const conf = exec("opnmesh-gw-a", "cat /etc/opnmesh/wg0.conf");
      expect(conf).toContain("[Interface]");
    } finally {
      sh("docker start opnmesh-control");
    }
    await waitConverged(90_000);
    expectNoFlap(hsBefore, handshakes("opnmesh-gw-a"));
  }, 120_000);
});
