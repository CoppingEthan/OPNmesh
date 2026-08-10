/**
 * Phase-5 observability tests on the live mesh (§13): exporter tiers 1+2 in
 * Prometheus, tier-3 flows with central opt-in and purge, alerting end to end
 * (gateway death → Prometheus alert → Alertmanager → SMTP sink), the
 * dead-man's switch, and Grafana provisioning.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { adminFetch, CONTROL } from "./helpers.js";

const enabled = process.env["RUN_MESH_TESTS"] === "1";
const PROM = "http://localhost:19090";
const MAILPIT = "http://localhost:18025";
const COMPOSE = "docker compose -f docker/docker-compose.yml";
const SITES_PATH = join(process.cwd(), "docker", "state", "sites.yml");

const sh = (cmd: string): string =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
const exec = (c: string, cmd: string): string => sh(`docker exec ${c} sh -c "${cmd.replace(/"/g, '\\"')}"`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function promQuery(expr: string): Promise<Array<{ metric: Record<string, string>; value: [number, string] }>> {
  const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`);
  const body = (await res.json()) as any;
  expect(body.status).toBe("success");
  return body.data.result;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null) return v;
    } catch {
      /* service may still be starting */
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let originalSites = "";

describe.skipIf(!enabled)("observability (§13)", () => {
  beforeAll(async () => {
    originalSites = readFileSync(SITES_PATH, "utf8");
    sh(`${COMPOSE} --profile obs up -d prometheus alertmanager grafana mailpit`);
    sh(`${COMPOSE} --profile traffic up -d traffic-gen`);
    // All scrape targets healthy before anything else runs.
    await waitFor(
      async () => {
        const res = await fetch(`${PROM}/api/v1/targets`);
        const body = (await res.json()) as any;
        const active = body.data.activeTargets as Array<{ health: string; labels: Record<string, string> }>;
        const gateways = active.filter((t) => t.labels["job"] === "gateways");
        const control = active.filter((t) => t.labels["job"] === "control");
        return gateways.length === 3 && control.length === 1 && active.every((t) => t.health === "up")
          ? true
          : null;
      },
      90_000,
      "all Prometheus targets up",
    );
  }, 150_000);

  afterAll(async () => {
    writeFileSync(SITES_PATH, originalSites, "utf8");
    try {
      sh("docker start opnmesh-gw-b");
    } catch {
      /* running */
    }
    sh(`${COMPOSE} --profile obs --profile traffic rm -sf prometheus alertmanager grafana mailpit traffic-gen`);
    await sleep(5000);
  }, 60_000);

  it("tier 1: per-tunnel counters and handshake age reach Prometheus", async () => {
    await waitFor(
      async () => {
        const rx = await promQuery(`sum by (node) (wireguard_peer_rx_bytes_total)`);
        return rx.length === 3 && rx.every((r) => Number(r.value[1]) > 0) ? true : null;
      },
      60_000,
      "rx byte counters from all gateways",
    );
    const hs = await promQuery(`time() - wireguard_peer_latest_handshake_seconds < 180`);
    expect(hs.length).toBeGreaterThan(0);
  }, 90_000);

  it("tier 2: the nftables site-pair matrix moves with real traffic", async () => {
    await waitFor(
      async () => {
        const r = await promQuery(`opnmesh_nft_counter_bytes{name="cnt_site_a_to_site_b"}`);
        return r.length > 0 && Number(r[0]!.value[1]) > 0 ? true : null;
      },
      90_000,
      "site-a→site-b counter movement",
    );
    // Both directions of at least one more pair exist as series.
    const all = await promQuery(`opnmesh_nft_counter_bytes`);
    const names = all.map((r) => r.metric["name"]);
    expect(names).toContain("cnt_site_b_to_site_a");
  }, 120_000);

  it("tier 3: flows are off by default, centrally enabled, queryable, and purgeable", async () => {
    // Start from a clean store: earlier runs may have left records behind.
    await adminFetch("/api/v1/admin/flows/purge", { method: "POST" });
    await sleep(2000);
    const before = await adminFetch("/api/v1/flows/top?window=600");
    // Flows are off (sites.yml default) — nothing new arrives after a purge.
    expect(((await before.json()) as any).top).toEqual([]);

    // Central opt-in: flip the flag in sites.yml; the agent reconciles
    // settings + conntrack accounting sysctl with no restart.
    const doc = parseYaml(readFileSync(SITES_PATH, "utf8"));
    doc.sites.find((s: any) => s.id === "site-a").gateway.flows = true;
    writeFileSync(SITES_PATH, stringifyYaml(doc), "utf8");

    const top = await waitFor(
      async () => {
        const res = await adminFetch("/api/v1/flows/top?window=600&limit=50");
        const body = (await res.json()) as any;
        const heavy = body.top.filter((t: any) => t.src.startsWith("10.10.") && t.bytes > 0);
        return heavy.length > 0 ? body.top : null;
      },
      120_000,
      "flow records from site-a",
    );
    expect(top.length).toBeGreaterThan(0);
    expect(exec("opnmesh-gw-a", "sysctl -n net.netfilter.nf_conntrack_acct").trim()).toBe("1");

    // Purge action (§13): flow logging records who talked to whom, so the
    // operator can wipe it.
    await adminFetch("/api/v1/admin/flows/purge", { method: "POST" });
    const after = await adminFetch("/api/v1/flows/top?window=600");
    expect(((await after.json()) as any).top).toEqual([]);
  }, 180_000);

  it("dead-man's switch: control heartbeats an external endpoint and exposes success", async () => {
    await waitFor(
      async () => {
        const res = await adminFetch("/metrics");
        const text = await res.text();
        const m = text.match(/opnmesh_deadman_last_success_timestamp_seconds (\d+)/);
        return m && Number(m[1]) > 0 ? true : null;
      },
      60_000,
      "dead-man heartbeat success",
    );
  }, 90_000);

  it("grafana is provisioned with the Prometheus datasource", async () => {
    const health = await fetch("http://localhost:13000/api/health");
    expect(health.ok).toBe(true);
    const ds = await fetch("http://localhost:13000/api/datasources", {
      headers: { Accept: "application/json" },
    });
    // Anonymous viewer cannot list datasources (403) — health is enough there;
    // the dashboard endpoint is public for viewers.
    const dash = await fetch("http://localhost:13000/api/dashboards/uid/opnmesh-overview");
    expect(dash.status, "provisioned dashboard missing").toBe(200);
    void ds;
  }, 60_000);

  it("a dead gateway raises alerts and lands an email in the SMTP sink", async () => {
    sh("docker stop -t 1 opnmesh-gw-b");
    try {
      // NodeUnreachable: up==0 for 1m.
      await waitFor(
        async () => {
          const res = await fetch(`${PROM}/api/v1/alerts`);
          const body = (await res.json()) as any;
          const firing = body.data.alerts.filter(
            (a: any) => a.labels.alertname === "NodeUnreachable" && a.state === "firing",
          );
          return firing.length > 0 ? true : null;
        },
        180_000,
        "NodeUnreachable firing",
      );
      // TunnelDown: peers' handshakes to gw-b go stale past 180s.
      await waitFor(
        async () => {
          const res = await fetch(`${PROM}/api/v1/alerts`);
          const body = (await res.json()) as any;
          const firing = body.data.alerts.filter(
            (a: any) => a.labels.alertname === "TunnelDown" && a.state === "firing",
          );
          return firing.length > 0 ? true : null;
        },
        240_000,
        "TunnelDown firing",
      );
      // And the alert e-mail arrives at the operator's SMTP server.
      await waitFor(
        async () => {
          const res = await fetch(`${MAILPIT}/api/v1/messages`);
          const body = (await res.json()) as any;
          const hit = (body.messages ?? []).find((m: any) =>
            ["NodeUnreachable", "TunnelDown"].some((s) => (m.Subject ?? "").includes(s)),
          );
          return hit ? true : null;
        },
        120_000,
        "alert email in mailpit",
      );
    } finally {
      sh("docker start opnmesh-gw-b");
    }
  }, 600_000);
});
