/**
 * §14 integration tests against the live compose mesh. Requires:
 *   npm run mesh:up      (build + start the simulation)
 *   npm run mesh:test    (sets RUN_MESH_TESTS=1)
 *
 * These assert packet-level behaviour: connectivity, source preservation,
 * client isolation in both directions, entry-point failover, and the
 * failure-domain rows of §10 (control death, gateway death).
 */
import { describe, expect, it, afterAll } from "vitest";
import { execSync } from "node:child_process";

const enabled = process.env["RUN_MESH_TESTS"] === "1";

const sh = (cmd: string): string =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });

const exec = (container: string, cmd: string): string =>
  sh(`docker exec ${container} sh -c "${cmd.replace(/"/g, '\\"')}"`);

const tryExec = (container: string, cmd: string): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: exec(container, cmd) };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pingOk(from: string, toIp: string, attempts = 15): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (tryExec(from, `ping -c 1 -W 2 ${toIp}`).ok) return true;
    await sleep(1000);
  }
  return false;
}

/** TCP connect attempt; returns whether the connection opened. */
function tcpOk(from: string, toIp: string, port: number, timeoutSec = 3): boolean {
  return tryExec(from, `nc -w ${timeoutSec} -z ${toIp} ${port}`).ok;
}

const HOSTS = {
  a: { name: "opnmesh-host-a", ip: "10.10.5.20" },
  b: { name: "opnmesh-host-b", ip: "10.20.5.20" },
  c: { name: "opnmesh-host-c", ip: "10.30.5.20" },
} as const;
const CLIENT = { name: "opnmesh-client", ip: "10.99.1.10" };

describe.skipIf(!enabled)("simulated mesh (§14)", () => {
  afterAll(() => {
    // Whatever a test killed, bring back.
    for (const c of ["opnmesh-gw-a", "opnmesh-gw-b", "opnmesh-gw-c", "opnmesh-control"]) {
      try {
        sh(`docker start ${c}`);
      } catch {
        /* already running */
      }
    }
  });

  it("mesh is up: every pair of LAN hosts can reach each other", async () => {
    expect(await pingOk(HOSTS.a.name, HOSTS.c.ip)).toBe(true);
    expect(await pingOk(HOSTS.a.name, HOSTS.b.ip)).toBe(true);
    expect(await pingOk(HOSTS.b.name, HOSTS.c.ip)).toBe(true);
  }, 90_000);

  it("source addresses are preserved end to end — no SNAT anywhere", async () => {
    // Capture on host-c while host-a pings it; the captured source must be
    // host-a's real LAN address, not a gateway address.
    sh(
      `docker exec -d ${HOSTS.c.name} sh -c "timeout 15 tcpdump -c 2 -n -i eth0 icmp > /tmp/cap.txt 2>&1"`,
    );
    await sleep(1500);
    expect(await pingOk(HOSTS.a.name, HOSTS.c.ip)).toBe(true);
    await sleep(2500);
    const cap = exec(HOSTS.c.name, "cat /tmp/cap.txt");
    expect(cap).toContain(`${HOSTS.a.ip} > ${HOSTS.c.ip}`);
  }, 60_000);

  it("TCP works across the tunnel (MSS clamp sanity)", () => {
    expect(tcpOk(HOSTS.a.name, HOSTS.c.ip, 5201)).toBe(true);
    // Move real data, not just a SYN: iperf3 for 2 seconds.
    const out = exec(HOSTS.a.name, `iperf3 -c ${HOSTS.c.ip} -t 2 -f m`);
    expect(out).toContain("receiver");
  }, 60_000);

  it("the client reaches LAN hosts at all three sites", async () => {
    expect(await pingOk(CLIENT.name, HOSTS.a.ip)).toBe(true);
    expect(await pingOk(CLIENT.name, HOSTS.b.ip)).toBe(true);
    expect(await pingOk(CLIENT.name, HOSTS.c.ip)).toBe(true);
    expect(tcpOk(CLIENT.name, HOSTS.b.ip, 5201)).toBe(true);
  }, 90_000);

  it("no LAN host at any site can open a connection to a client", async () => {
    // Warm the path so the client's tunnel is definitely up first.
    expect(await pingOk(CLIENT.name, HOSTS.a.ip)).toBe(true);
    for (const h of Object.values(HOSTS)) {
      expect(tcpOk(h.name, CLIENT.ip, 5201), `${h.name} opened a connection to the client`).toBe(false);
      expect(tryExec(h.name, `ping -c 1 -W 2 ${CLIENT.ip}`).ok, `${h.name} pinged the client`).toBe(false);
    }
    // ...while the reverse direction (client → host) still works, proving the
    // block is directional, not a broken route.
    expect(tcpOk(CLIENT.name, HOSTS.a.ip, 5201)).toBe(true);
  }, 120_000);

  it("client fails over: killing its first entry point keeps other sites reachable", async () => {
    sh("docker stop -t 1 opnmesh-gw-a");
    try {
      expect(await pingOk(CLIENT.name, HOSTS.b.ip, 20)).toBe(true);
      expect(await pingOk(CLIENT.name, HOSTS.c.ip, 20)).toBe(true);
    } finally {
      sh("docker start opnmesh-gw-a");
    }
    // And site-a comes back.
    expect(await pingOk(CLIENT.name, HOSTS.a.ip, 30)).toBe(true);
  }, 180_000);

  it("killing the control node stops no tunnel; restoring it causes no flap", async () => {
    const handshakeBefore = exec("opnmesh-gw-a", "wg show wg0 latest-handshakes");
    sh("docker stop -t 1 opnmesh-control");
    try {
      expect(await pingOk(HOSTS.a.name, HOSTS.c.ip)).toBe(true);
      expect(await pingOk(HOSTS.b.name, HOSTS.c.ip)).toBe(true);
      expect(await pingOk(CLIENT.name, HOSTS.b.ip)).toBe(true);
    } finally {
      sh("docker start opnmesh-control");
    }
    await sleep(3000);
    expect(await pingOk(HOSTS.a.name, HOSTS.c.ip)).toBe(true);
    // No tunnel flap: the wg interface was never re-created. Handshake times
    // only move forward; a reset interface would clear them.
    const handshakeAfter = exec("opnmesh-gw-a", "wg show wg0 latest-handshakes");
    const parse = (s: string) =>
      new Map(
        s
          .trim()
          .split("\n")
          .map((l) => l.split("\t") as [string, string])
          .map(([k, v]) => [k, Number(v)]),
      );
    const before = parse(handshakeBefore);
    for (const [key, after] of parse(handshakeAfter)) {
      const prev = before.get(key);
      if (prev && prev > 0) expect(after, `handshake for ${key} went backwards`).toBeGreaterThanOrEqual(prev);
    }
  }, 120_000);

  it("killing one gateway leaves the other two sites connected", async () => {
    sh("docker stop -t 1 opnmesh-gw-b");
    try {
      expect(await pingOk(HOSTS.a.name, HOSTS.c.ip, 20)).toBe(true);
      // And site-b is genuinely down, not accidentally reachable some other way.
      expect(tryExec(HOSTS.a.name, `ping -c 1 -W 2 ${HOSTS.b.ip}`).ok).toBe(false);
    } finally {
      sh("docker start opnmesh-gw-b");
    }
    expect(await pingOk(HOSTS.a.name, HOSTS.b.ip, 30)).toBe(true);
  }, 180_000);
});
