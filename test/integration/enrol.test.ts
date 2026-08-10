/**
 * Phase-4 end-to-end enrolment on the live mesh (§12): a factory-fresh
 * gateway container (site-d) fetches install.sh, generates its keypair
 * locally, enrols with a one-time token, sits pending with no access, and —
 * once approved — pulls config and joins the mesh without disturbing the
 * existing tunnels. Plus negative paths: single-use, TTL, pending refusal.
 */
import { describe, expect, it, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const enabled = process.env["RUN_MESH_TESTS"] === "1";
const CONTROL = "http://localhost:18080";
const COMPOSE = "docker compose -f docker/docker-compose.yml";

const sh = (cmd: string, env: Record<string, string> = {}): string =>
  execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
const exec = (c: string, cmd: string): string => sh(`docker exec ${c} sh -c "${cmd.replace(/"/g, '\\"')}"`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${CONTROL}${path}`, init);
  const parsed = await res.json();
  return { status: res.status, body: parsed };
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${what}`);
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

const SITE_D = {
  id: "site-d",
  name: "Site D",
  lan: "10.40.0.0/16",
  gateway: {
    name: "Gateway D",
    lan_ip: "10.40.0.2",
    tunnel_ip: "10.99.0.4",
    endpoint: "198.51.100.40",
  },
};

describe.skipIf(!enabled)("enrolment (§12)", () => {
  afterAll(async () => {
    // Decommission site-d regardless of test outcome and let the mesh settle.
    try {
      await api("POST", "/api/v1/admin/remove", { siteId: "site-d" });
    } catch {
      /* not enrolled */
    }
    try {
      sh(`${COMPOSE} --profile enrol rm -sf gw-d host-d`);
    } catch {
      /* not running */
    }
    await sleep(8000);
  }, 60_000);

  it("issued tokens advertise the installer checksum shown in the UI", async () => {
    const { status, body } = await api("POST", "/api/v1/admin/enrol-tokens", {
      role: "gateway",
      note: "checksum-check",
    });
    expect(status).toBe(200);
    const local = createHash("sha256")
      .update(readFileSync(join(process.cwd(), "deploy", "install.sh")))
      .digest("hex");
    expect(body.installShSha256).toBe(local);
    // install.sh is served with the same hash in a header.
    const res = await fetch(`${CONTROL}/install.sh`);
    expect(res.headers.get("x-install-sha256")).toBe(local);
  });

  it("expired and reused tokens are refused", async () => {
    const short = await api("POST", "/api/v1/admin/enrol-tokens", {
      role: "gateway",
      note: "ttl-test",
      ttlMs: 1000,
    });
    await sleep(2000);
    const KEY = "c".repeat(43) + "=";
    const expired = await api("POST", "/api/v1/enrol", {
      token: short.body.token,
      publicKey: KEY,
      hostname: "x",
      addresses: [],
    });
    expect(expired.status).toBe(400);
    expect(expired.body.error).toBe("expired");

    const good = await api("POST", "/api/v1/admin/enrol-tokens", { role: "gateway", note: "reuse-test" });
    const first = await api("POST", "/api/v1/enrol", {
      token: good.body.token,
      publicKey: KEY,
      hostname: "reuse-1",
      addresses: [],
    });
    expect(first.status).toBe(200);
    const second = await api("POST", "/api/v1/enrol", {
      token: good.body.token,
      publicKey: "d".repeat(43) + "=",
      hostname: "reuse-2",
      addresses: [],
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe("already-used");
    // Tidy the pending entry from this test.
    await api("POST", "/api/v1/admin/reject", { pendingId: first.body.pendingId });
  });

  it("a factory-fresh gateway enrols, waits pending with no access, joins on approval, and the mesh does not flap", async () => {
    const hsBefore = handshakes("opnmesh-gw-a");

    // 1. Admin issues a role-bound one-time token.
    const issued = await api("POST", "/api/v1/admin/enrol-tokens", { role: "gateway", note: "site-d" });
    expect(issued.status).toBe(200);

    // 2. Boot the fresh node with only the token — it runs install.sh itself.
    sh(`${COMPOSE} --profile enrol up -d gw-d host-d`, { ENROL_TOKEN: issued.body.token });

    // 3. It appears as pending, reporting its locally generated public key.
    const pending = await waitFor(
      async () => {
        const { body } = await api("GET", "/api/v1/admin/pending");
        return body.pending.find((p: any) => p.hostname === "gw-d") ?? null;
      },
      60_000,
      "pending node gw-d",
    );
    expect(pending.role).toBe("gateway");
    expect(pending.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(pending.fingerprint).toHaveLength(16);

    // 4. Pending means NO configuration and no access.
    await sleep(4000); // a few agent polls
    expect(() => exec("opnmesh-gw-d", "test -f /etc/opnmesh/wg0.conf")).toThrow();
    // ...but the private key exists locally and never left the box: the
    // control node knows only the public key.
    exec("opnmesh-gw-d", "test -f /etc/opnmesh/keys/wg0.key");

    // 5. Admin reviews and approves, assigning the site entry.
    const approved = await api("POST", "/api/v1/admin/approve", {
      pendingId: pending.id,
      site: SITE_D,
    });
    expect(approved.status).toBe(200);

    // 6. The node pulls config and becomes active; tunnels form.
    await waitFor(
      async () => {
        try {
          exec("opnmesh-host-d", "ping -c 1 -W 2 10.10.5.20");
          return true;
        } catch {
          return null;
        }
      },
      90_000,
      "host-d reaching host-a across the new tunnel",
    );
    // Bidirectional, and reaching a second site too (retried: the reverse
    // direction can race the last gateway's reconcile by a poll or two).
    const pingRetry = async (from: string, ip: string) => {
      for (let i = 0; i < 10; i++) {
        try {
          exec(from, `ping -c 1 -W 2 ${ip}`);
          return;
        } catch {
          await sleep(1000);
        }
      }
      throw new Error(`${from} cannot reach ${ip}`);
    };
    await pingRetry("opnmesh-host-a", "10.40.5.20");
    await pingRetry("opnmesh-host-d", "10.30.5.20");

    // 7. Existing tunnels never flapped while site-d joined.
    const hsAfter = handshakes("opnmesh-gw-a");
    for (const [key, ts] of hsAfter) {
      const prev = hsBefore.get(key);
      if (prev && prev > 0) expect(ts, `handshake for ${key} reset`).toBeGreaterThanOrEqual(prev);
    }
  }, 240_000);
});
