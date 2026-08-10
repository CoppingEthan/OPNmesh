/**
 * Phase-6 auto-update tests on the live mesh (§11): signed releases, staged
 * rollout with canary soak, freeze mid-rollout, broken-release automatic
 * rollback with rollout abort, the config-neutrality gate, coordinated port
 * changes with mesh-wide verification, and the boot watchdog.
 *
 * Run via `npm run mesh:update-test` (or as part of mesh:test — this file
 * sorts last so its version churn cannot disturb the other suites).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { adminFetch, adminJson, adminToken, CONTROL } from "./helpers.js";

const enabled = process.env["RUN_MESH_TESTS"] === "1";
const GATEWAYS = ["site-a", "site-b", "site-c"] as const;

const sh = (cmd: string): string =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
const exec = (c: string, cmd: string): string => sh(`docker exec ${c} sh -c "${cmd.replace(/"/g, '\\"')}"`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = adminJson;

async function nodeVersions(): Promise<Record<string, string>> {
  const { body } = await api("GET", "/api/v1/state");
  const out: Record<string, string> = {};
  for (const id of GATEWAYS) out[id] = body.nodes[id]?.version ?? "";
  return out;
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

function buildRelease(version: string, flags = ""): void {
  // build-release registers the release through the management API.
  sh(`npx cross-env OPNMESH_ADMIN_TOKEN=${adminToken()} npx tsx docker/build-release.ts --version ${version} ${flags}`);
}

async function auditEvents(): Promise<Array<{ ts: number; type: string; detail: string }>> {
  const { body } = await api("GET", "/api/v1/admin/audit");
  return body.audit;
}

function handshakes(container: string): Map<string, number> {
  const out = exec(container, "wg show wg0 latest-handshakes");
  return new Map(
    out.trim().split("\n").filter(Boolean).map((l) => {
      const [key, ts] = l.split("\t");
      return [key!, Number(ts)] as const;
    }),
  );
}

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

describe.skipIf(!enabled)("auto-update (§11) and coordinated port changes (§6)", () => {
  beforeAll(async () => {
    // Reset update controls that a previous run may have left behind.
    await api("POST", "/api/v1/admin/freeze", { frozen: false });
    await api("POST", "/api/v1/admin/window", { updateWindow: "always" });
    await api("POST", "/api/v1/admin/rollout/cancel");
    // Mesh must be converged and reporting before update games start.
    await waitFor(
      async () => {
        const { body } = await api("GET", "/api/v1/state");
        return GATEWAYS.every((id) => body.nodes[id]?.lastSeen && body.nodes[id]?.lastError === "")
          ? true
          : null;
      },
      90_000,
      "mesh converged",
    );
  }, 120_000);

  afterAll(async () => {
    await api("POST", "/api/v1/admin/freeze", { frozen: false });
    try {
      sh("docker start opnmesh-control");
    } catch {
      /* running */
    }
  });

  it("coordinated port change: one transaction, mesh re-forms, nobody stranded", async () => {
    const res = await api("POST", "/api/v1/admin/change-port", {
      siteId: "site-a",
      port: 52001,
      verifyWindowSec: 90,
    });
    expect(res.status).toBe(200);
    // The operator is told which tunnels will blip before anything applies.
    expect(res.body.affectedTunnels).toEqual(["site-a ↔ site-b", "site-a ↔ site-c"]);
    expect(res.body.warning).toContain("brief interruption");

    // Mesh-wide verification succeeds: change sticks, all tunnels fresh.
    await waitFor(
      async () => ((await api("GET", "/api/v1/admin/port-change")).body.active === null ? true : null),
      120_000,
      "port change verified",
    );
    const audit = await auditEvents();
    expect(audit.some((e) => e.type === "port-change:verified")).toBe(true);
    expect(exec("opnmesh-gw-a", "wg show wg0 listen-port").trim()).toBe("52001");
    expect(await pingOk("opnmesh-host-a", "10.30.5.20")).toBe(true);
    expect(await pingOk("opnmesh-host-c", "10.10.5.20")).toBe(true);

    // And back again — the revert is a coordinated change too.
    await api("POST", "/api/v1/admin/change-port", { siteId: "site-a", port: 51820, verifyWindowSec: 90 });
    await waitFor(
      async () => ((await api("GET", "/api/v1/admin/port-change")).body.active === null ? true : null),
      120_000,
      "port revert verified",
    );
    expect(exec("opnmesh-gw-a", "wg show wg0 listen-port").trim()).toBe("51820");
  }, 300_000);

  it("staged rollout: signed release, canary soaks, one node at a time, no tunnel flap", async () => {
    const hsBefore = handshakes("opnmesh-gw-a");
    buildRelease("2.0.0");
    const t0 = Date.now();
    const created = await api("POST", "/api/v1/admin/rollout", {
      version: "2.0.0",
      canary: "site-b",
      soakSec: 10,
      failTimeoutSec: 120,
    });
    expect(created.status).toBe(200);
    expect(created.body.plan).toEqual(["site-b", "site-a", "site-c"]);

    await waitFor(
      async () => {
        const { body } = await api("GET", "/api/v1/admin/rollout");
        return body.rollout?.status === "done" ? true : null;
      },
      240_000,
      "rollout done",
    );
    await waitFor(
      async () => {
        const v = await nodeVersions();
        return GATEWAYS.every((id) => v[id] === "2.0.0") ? true : null;
      },
      120_000,
      "all nodes reporting 2.0.0",
    );

    // Strictly one at a time: started(b) < done(b) ≤ started(a) < done(a) ≤ started(c).
    // Scoped to THIS rollout — the audit log deliberately accumulates.
    const audit = (await auditEvents()).filter((e) => e.ts >= t0);
    const seq = audit.filter((e) => e.type === "rollout:node-started" || e.type === "rollout:node-done");
    const startedOrder = seq.filter((e) => e.type === "rollout:node-started").map((e) => e.detail.split(" ")[0]);
    expect(startedOrder).toEqual(["site-b", "site-a", "site-c"]);
    for (let i = 0; i < seq.length - 1; i++) {
      expect(seq[i]!.ts).toBeLessThanOrEqual(seq[i + 1]!.ts);
    }
    expect(audit.some((e) => e.type === "rollout:soak-complete")).toBe(true);

    // An agent self-update never touches WireGuard: zero flaps.
    const hsAfter = handshakes("opnmesh-gw-a");
    for (const [key, ts] of hsAfter) {
      const prev = hsBefore.get(key);
      if (prev && prev > 0) expect(ts, `handshake for ${key} reset`).toBeGreaterThanOrEqual(prev);
    }
  }, 480_000);

  it("global freeze takes effect immediately, including mid-rollout", async () => {
    buildRelease("2.0.1");
    await api("POST", "/api/v1/admin/window", { updateWindow: "never" });
    const created = await api("POST", "/api/v1/admin/rollout", {
      version: "2.0.1",
      canary: "site-b",
      // Long soak so the freeze lands deterministically before the next node
      // could become eligible.
      soakSec: 60,
      failTimeoutSec: 300,
    });
    expect(created.status).toBe(200);

    // Outside the maintenance window nothing moves at all: sample repeatedly.
    for (let i = 0; i < 5; i++) {
      await sleep(3000);
      const v = await nodeVersions();
      for (const id of GATEWAYS) expect(v[id], `${id} updated outside the window`).not.toBe("2.0.1");
    }

    // Open the window; canary updates; freeze during/after canary → the
    // next node must not start.
    await api("POST", "/api/v1/admin/window", { updateWindow: "always" });
    await waitFor(
      async () => (((await nodeVersions())["site-b"]) === "2.0.1" ? true : null),
      120_000,
      "canary on 2.0.1",
    );
    await api("POST", "/api/v1/admin/freeze", { frozen: true });
    for (let i = 0; i < 6; i++) {
      await sleep(3500);
      const during = await nodeVersions();
      expect(during["site-a"], "site-a updated while frozen").not.toBe("2.0.1");
      expect(during["site-c"], "site-c updated while frozen").not.toBe("2.0.1");
    }

    await api("POST", "/api/v1/admin/freeze", { frozen: false });
    await waitFor(
      async () => {
        const { body } = await api("GET", "/api/v1/admin/rollout");
        return body.rollout?.status === "done" ? true : null;
      },
      240_000,
      "rollout completes after unfreeze",
    );
    expect(await nodeVersions()).toEqual({ "site-a": "2.0.1", "site-b": "2.0.1", "site-c": "2.0.1" });
  }, 600_000);

  it("a broken release rolls back automatically on the canary and aborts the rollout", async () => {
    buildRelease("9.9.9", "--broken");
    const created = await api("POST", "/api/v1/admin/rollout", {
      version: "9.9.9",
      canary: "site-a",
      soakSec: 5,
      failTimeoutSec: 120,
    });
    expect(created.status).toBe(200);

    await waitFor(
      async () => {
        const { body } = await api("GET", "/api/v1/admin/rollout");
        return body.rollout?.status === "aborted" ? true : null;
      },
      240_000,
      "rollout aborted",
    );

    // Commit-confirm reverted the canary to its previous version — an alert,
    // not a lockout. Wait for post-revert reports to land.
    const state = await waitFor(
      async () => {
        const { body } = await api("GET", "/api/v1/state");
        const a = body.nodes["site-a"];
        return a?.version === "2.0.1" && (a?.lastUpdateError ?? "").includes("9.9.9") ? body : null;
      },
      120_000,
      "canary reverted to 2.0.1 and reporting the failure",
    );
    // Nobody else ever got the broken build.
    expect(state.nodes["site-b"].version).toBe("2.0.1");
    expect(state.nodes["site-c"].version).toBe("2.0.1");
    // Data plane untouched throughout.
    expect(await pingOk("opnmesh-host-a", "10.30.5.20")).toBe(true);

    const metrics = await (await adminFetch("/metrics")).text();
    expect(metrics).toMatch(/opnmesh_rollout_aborted 1/);
    expect(metrics).toMatch(/opnmesh_node_update_error\{node="site-a"\} 1/);
    const audit = await auditEvents();
    expect(audit.some((e) => e.type === "rollout:rollout-aborted" && e.detail.includes("site-a"))).toBe(true);
  }, 480_000);

  it("boot watchdog: broken config at boot with control unreachable reverts to last-known-good", async () => {
    sh("docker stop -t 1 opnmesh-control");
    try {
      // Point every peer endpoint somewhere dead AND move the listen port so
      // peers cannot dial in either, then reboot the node: it comes up with a
      // config that can never handshake and no control node to fix it. The
      // watchdog must restore the snapshot by itself.
      exec("opnmesh-gw-b", "sed -i 's/^Endpoint = .*/Endpoint = 203.0.113.99:40000/' /etc/opnmesh/wg0.conf");
      exec("opnmesh-gw-b", "sed -i 's/^ListenPort = .*/ListenPort = 40404/' /etc/opnmesh/wg0.conf");
      sh("docker restart opnmesh-gw-b");

      await waitFor(
        async () => {
          try {
            const conf = exec("opnmesh-gw-b", "cat /etc/opnmesh/wg0.conf");
            return conf.includes("203.0.113.99") ? null : true;
          } catch {
            return null;
          }
        },
        120_000,
        "watchdog restored last-known-good config",
      );
      expect(await pingOk("opnmesh-host-b", "10.10.5.20", 30)).toBe(true);
    } finally {
      sh("docker start opnmesh-control");
    }
  }, 300_000);

  it("config-neutrality gate: a release that would change generated config is blocked pending approval", async () => {
    const releases = join(process.cwd(), "docker", "state", "control", "releases");
    // Same binary, different claimed generator output digest.
    if (!existsSync(join(releases, "3.0.0"))) {
      cpSync(join(releases, "2.0.1"), join(releases, "3.0.0"), { recursive: true });
    }
    const sha = readFileSync(join(releases, "2.0.1", "manifest.json"), "utf8");
    const sha256 = (JSON.parse(sha) as { sha256: string }).sha256;

    await api("POST", "/api/v1/admin/window", { updateWindow: "never" }); // belt: nothing may actually roll out
    const reg = await api("POST", "/api/v1/admin/releases", {
      version: "3.0.0",
      sha256,
      configDigest: "deadbeef".repeat(8),
    });
    expect(reg.status).toBe(200);

    const blocked = await api("POST", "/api/v1/admin/rollout", { version: "3.0.0", canary: "site-a" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.blocked).toBe(true);
    expect(blocked.body.reason).toContain("different WireGuard config");
    const audit = await auditEvents();
    expect(audit.some((e) => e.type === "rollout:blocked" && e.detail.includes("3.0.0"))).toBe(true);

    // Explicit approval is the only way past the gate.
    const approved = await api("POST", "/api/v1/admin/rollout", {
      version: "3.0.0",
      canary: "site-a",
      approveConfigChange: true,
    });
    expect(approved.status).toBe(200);

    // Clean up: cancel the approved rollout and restore the window so this
    // suite is re-runnable and later suites see a quiet mesh.
    await api("POST", "/api/v1/admin/rollout/cancel");
    await api("POST", "/api/v1/admin/window", { updateWindow: "always" });
  }, 120_000);
});
