/**
 * End-to-end: build a four-site mesh through the real controller API, enrol
 * real agents in Ubuntu containers, apply the printed router instructions to
 * real Linux routers, and prove connectivity, isolation, resilience and the
 * live dashboard data. Run with `npm run sim:up && npm run sim:test`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API, api, compose, execDetached, getCookie, httpStatus, must, mustExec, ping, setCookie, setupCodeFromLogs, sleep, waitFor, writeState } from "./helpers";

const T = 240_000;

interface SiteRef {
  id: string;
  slug: string;
}
const sites: Record<"a" | "b" | "c" | "d", SiteRef> = {} as never;
const ROUTER: Record<string, string> = { a: "router-a", b: "router-b", c: "router-c", d: "router-d" };
const HOST_IP: Record<string, string> = { a: "10.0.1.20", b: "192.168.20.20", c: "10.30.0.20", d: "10.40.0.20" };
const GW_LAN_IP: Record<string, string> = { a: "10.0.250.2", b: "192.168.20.2", c: "10.30.0.2", d: "10.40.250.2" };

async function state() {
  return must<any>("GET", "/api/admin/state");
}

async function waitConfigCurrent(label: string, timeoutMs = 90_000) {
  return waitFor(
    label,
    async () => {
      const s = await state();
      const gws = s.sites.filter((x: any) => x.gateway).map((x: any) => x.gateway);
      return gws.length > 0 && gws.every((g: any) => g.health === "online" && g.configCurrent && !g.attention) ? s : null;
    },
    { timeoutMs, intervalMs: 3000 },
  );
}

function applyRouterPlan(site: "a" | "b" | "c" | "d", plan: any) {
  const router = ROUTER[site]!;
  for (const r of plan.routes) {
    if (!r.required) continue;
    mustExec(router, `ip route replace ${r.cidr} via ${plan.nextHop}`);
  }
  if (plan.allStatesPolicy) {
    const dests = plan.allStatesPolicy.destinations.join(", ");
    const lanIf = mustExec(router, `ip -o -4 addr show | awk '$4 ~ "^${GW_LAN_IP[site]!.split(".").slice(0, 3).join(".")}" {print $2; exit}'`).trim();
    mustExec(router, `nft insert rule inet router forward iifname "${lanIf}" ip daddr { ${dests} } accept comment "opnmesh-policy"`);
  }
}

function removeAllStatesPolicy(router: string) {
  const handle = /handle (\d+)/.exec(mustExec(router, `nft -a list chain inet router forward | grep opnmesh-policy || true`))?.[1];
  if (handle) mustExec(router, `nft delete rule inet router forward handle ${handle}`);
}

describe("OPNmesh four-site simulation", () => {
  beforeAll(async () => {
    await waitFor("controller API", async () => (await api("GET", "/api/admin/setup")).status === 200, { timeoutMs: 120_000 });
  }, 130_000);

  it("first-run setup creates the admin from the code in the controller log", async () => {
    const setup = await api<{ needsSetup: boolean }>("GET", "/api/admin/setup");
    if (setup.body.needsSetup) {
      const code = await waitFor("setup code in logs", () => setupCodeFromLogs(), { timeoutMs: 60_000 });
      const r = await api("POST", "/api/admin/setup", { code, email: "admin@example.com", password: "simulation password 1" });
      expect(r.status).toBe(200);
      setCookie(r.headers.get("set-cookie")!.split(";")[0]!);
    } else {
      const r = await api("POST", "/api/admin/login", { email: "admin@example.com", password: "simulation password 1" });
      expect(r.status).toBe(200);
      setCookie(r.headers.get("set-cookie")!.split(";")[0]!);
    }
    expect((await api("GET", "/api/admin/state")).status).toBe(200);
  }, T);

  it("creates four sites with their networks and router layouts", async () => {
    const existing = await must<any[]>("GET", "/api/admin/sites");
    for (const s of existing) await must("DELETE", `/api/admin/sites/${s.id}`);
    const defs = [
      ["a", "Datacentre", "transit", 1, "10.0.1.0/24", "Servers"],
      ["b", "Office", "same_lan", 2, "192.168.20.0/24", "Staff"],
      ["c", "Warehouse", "masquerade", 3, "10.30.0.0/24", "Warehouse"],
      ["d", "Shop", "transit", 4, "10.40.0.0/24", "Shop floor"],
    ] as const;
    for (const [key, name, layout, prio, cidr, lanName] of defs) {
      const site = await must<any>("POST", "/api/admin/sites", { name, routerLayout: layout, hubPriority: prio });
      await must("POST", `/api/admin/sites/${site.id}/lans`, { cidr, name: lanName });
      sites[key] = { id: site.id, slug: site.slug };
    }
    expect(Object.keys(sites)).toHaveLength(4);
  }, T);

  it("gateways enrol with one-time tokens and come online", async () => {
    for (const key of ["a", "b", "c", "d"] as const) {
      const tok = await must<any>("POST", `/api/admin/sites/${sites[key].id}/enrol-token`, {});
      expect(tok.command).toContain("curl -fsSL http://198.51.100.10:3000/install.sh");
      writeState(`gw-${key}/enrol.token`, tok.token + "\n");
    }
    const s = await waitFor(
      "all four gateways online",
      async () => {
        const st = await state();
        const online = st.sites.filter((x: any) => x.gateway?.health === "online");
        return online.length === 4 ? st : null;
      },
      { timeoutMs: 180_000, intervalMs: 3000 },
    );
    for (const key of ["a", "b", "c", "d"] as const) {
      const site = s.sites.find((x: any) => x.id === sites[key].id);
      expect(site.gateway.lanIp, key).toBe(GW_LAN_IP[key]);
      expect(site.gateway.status).toBe("active");
    }
    // A and B accept inbound tunnels; C and D dial out.
    await must("PATCH", `/api/admin/sites/${sites.a.id}/gateway`, { endpointHost: "198.51.100.10" });
    await must("PATCH", `/api/admin/sites/${sites.b.id}/gateway`, { endpointHost: "198.51.100.20" });
    const st = await waitConfigCurrent("gateways applied the topology", 120_000);
    expect(st.findings.filter((f: any) => f.level === "error")).toEqual([]);
    const cd = st.tunnels.find((t: any) => [t.a, t.b].sort().join() === [sites.c.id, sites.d.id].sort().join());
    expect(cd.kind).toBe("transit");
    expect(cd.via).toBe(sites.a.id);
  }, T);

  it("applies exactly what the router page prints to each router", async () => {
    for (const key of ["a", "b", "c", "d"] as const) {
      const r = await must<any>("GET", `/api/admin/sites/${sites[key].id}/router`);
      expect(r.plan.nextHop).toBe(GW_LAN_IP[key]);
      applyRouterPlan(key, r.plan);
    }
    const b = await must<any>("GET", `/api/admin/sites/${sites.b.id}/router`);
    expect(b.plan.allStatesPolicy).not.toBeNull();
    expect(b.plan.portForward).toEqual({ protocol: "udp", port: 51820, toIp: "192.168.20.2" });
    const c = await must<any>("GET", `/api/admin/sites/${sites.c.id}/router`);
    expect(c.plan.portForward).toBeNull();
    expect(c.plan.routes.every((x: any) => !x.required)).toBe(true);
    expect(mustExec("router-a", "ip route")).toContain("192.168.20.0/24 via 10.0.250.2");
    expect(mustExec("router-b", "nft list chain inet router forward")).toContain("opnmesh-policy");
  }, T);

  it("every direct tunnel handshakes and answers pings", async () => {
    const st = await waitFor(
      "all direct tunnels up",
      async () => {
        const s = await state();
        const direct = s.tunnels.filter((t: any) => t.kind === "direct");
        return direct.length === 5 && direct.every((t: any) => t.health === "up") ? s : null;
      },
      { timeoutMs: 120_000, intervalMs: 3000 },
    );
    for (const t of st.tunnels.filter((t: any) => t.kind === "direct")) {
      expect(t.rttMs, `${t.a}-${t.b} rtt`).toBeGreaterThan(0);
    }
  }, T);

  it("hosts reach each other by their real addresses across every site pair", async () => {
    // A (hub) ↔ everyone, B ↔ D direct, B ↔ C direct, D ↔ C through A.
    for (const [from, to] of [
      ["a", "b"], ["b", "a"],
      ["a", "d"], ["d", "a"],
      ["b", "d"], ["d", "b"],
      ["a", "c"], ["b", "c"], ["d", "c"],
    ] as const) {
      expect(ping(`host-${from}`, HOST_IP[to]!), `host-${from} → host-${to}`).toBe(true);
    }
    // Hosts at the masquerade site cannot initiate: its router has no routes (by design).
    expect(ping("host-c", HOST_IP.a!, 2)).toBe(false);

    // Source addresses survive, except into the masquerade site.
    expect(httpStatus("host-a", `http://${HOST_IP.b}:8000/`)).toBe(200);
    expect(httpStatus("host-d", `http://${HOST_IP.b}:8000/`)).toBe(200);
    expect(httpStatus("host-b", `http://${HOST_IP.d}:8000/`)).toBe(200);
    expect(httpStatus("host-a", `http://${HOST_IP.c}:8000/`)).toBe(200);
    expect(httpStatus("host-d", `http://${HOST_IP.c}:8000/`)).toBe(200);
    const logB = mustExec("host-b", "cat /var/log/http.log");
    expect(logB).toContain("10.0.1.20 - -");
    expect(logB).toContain("10.40.0.20 - -");
    const logD = mustExec("host-d", "cat /var/log/http.log");
    expect(logD).toContain("192.168.20.20 - -");
    const logC = mustExec("host-c", "cat /var/log/http.log");
    expect(logC).toContain("10.30.0.2 - -"); // the gateway's address: masquerade layout
    expect(logC).not.toContain("10.0.1.20 - -");
  }, T);

  it("health checks pass at every site and catch a missing router route", async () => {
    const run = async (id: string) => {
      await must("POST", `/api/admin/sites/${id}/diagnostics`, {});
      return waitFor(
        "gateway answered the health checks",
        async () => {
          const d = await must<any>("GET", `/api/admin/sites/${id}/diagnostics`);
          return d.pending ? null : d;
        },
        { timeoutMs: 90_000, intervalMs: 2000 },
      );
    };
    for (const key of ["a", "b", "c", "d"] as const) {
      const d = await run(sites[key].id);
      const all = [...d.controller, ...d.agent];
      expect(d.agent.length, `${key}: gateway-side results`).toBeGreaterThan(0);
      expect(all.filter((c: any) => c.status === "fail"), `${key}: ${JSON.stringify(all.filter((c: any) => c.status !== "pass"))}`).toEqual([]);
      const ids = all.map((c: any) => c.id);
      expect(ids).toContain("forwarding");
      expect(ids).toContain("firewall");
      expect(ids).toContain("routes");
      if (key === "c") {
        // Masquerade: the router needs no routes, so the probe is skipped.
        expect(d.agent.find((c: any) => c.id === "router-routes")?.status).toBe("skip");
        expect(d.controller.find((c: any) => c.id === "inbound")?.status).toBe("skip");
      } else {
        expect(d.agent.filter((c: any) => c.id.startsWith("router-route:") && c.status === "pass").length, `${key}: router probes`).toBeGreaterThan(0);
      }
      if (key === "a" || key === "b") expect(d.controller.find((c: any) => c.id === "inbound")?.status).toBe("pass");
      expect(d.agent.filter((c: any) => c.id.startsWith("mtu:")).every((c: any) => c.status === "pass"), `${key}: mtu`).toBe(true);
    }
    // Delete one static route on the office router: the probe must name that network.
    mustExec("router-b", "ip route del 10.0.1.0/24");
    try {
      const d = await run(sites.b.id);
      const missing = d.agent.find((c: any) => c.id === "router-route:10.0.1.0/24");
      expect(missing?.status, JSON.stringify(missing)).toBe("fail");
      expect(missing.hint).toContain("10.0.1.0/24 via 192.168.20.2");
      // The other routes are still fine.
      expect(d.agent.find((c: any) => c.id === "router-route:10.40.0.0/24")?.status).toBe("pass");
    } finally {
      mustExec("router-b", "ip route replace 10.0.1.0/24 via 192.168.20.2");
    }
    const again = await run(sites.b.id);
    expect(again.agent.find((c: any) => c.id === "router-route:10.0.1.0/24")?.status).toBe("pass");
  }, T);

  it("bulk TCP transfers work (MSS clamping) and iperf3 shows real throughput", async () => {
    const dl = mustExec("host-a", `curl -s -o /tmp/1m.bin -w '%{size_download}' --max-time 60 http://${HOST_IP.b}:8000/1m.bin`, { timeoutMs: 70_000 });
    expect(Number(dl.trim())).toBe(1048576);
    const dl2 = mustExec("host-d", `curl -s -o /tmp/1m.bin -w '%{size_download}' --max-time 60 http://${HOST_IP.c}:8000/1m.bin`, { timeoutMs: 70_000 });
    expect(Number(dl2.trim())).toBe(1048576);
    const iperf = mustExec("host-a", `iperf3 -c ${HOST_IP.b} -t 3 -J`, { timeoutMs: 60_000 });
    const bps = JSON.parse(iperf).end.sum_received.bits_per_second as number;
    expect(bps).toBeGreaterThan(1_000_000);
    console.log(`iperf3 host-a → host-b: ${(bps / 1e6).toFixed(0)} Mbit/s`);
  }, T);

  it("demonstrates the same-LAN trap: without the all-states policy TCP hangs while ping works", async () => {
    const plan = (await must<any>("GET", `/api/admin/sites/${sites.b.id}/router`)).plan;
    removeAllStatesPolicy("router-b");
    try {
      expect(mustExec("router-b", "nft list chain inet router forward")).not.toContain("opnmesh-policy");
      mustExec("router-b", "conntrack -F 2>/dev/null || true");
      // Outbound from the office: the router sees the SYN, never the SYN-ACK, drops the rest as invalid.
      expect(ping("host-b", HOST_IP.a!)).toBe(true);
      expect(httpStatus("host-b", `http://${HOST_IP.a}:8000/`, 6)).toBe(0);
    } finally {
      applyRouterPlan("b", plan);
    }
    expect(httpStatus("host-b", `http://${HOST_IP.a}:8000/`)).toBe(200);
  }, T);

  it("keeps working with the controller stopped, and gateways reconnect afterwards", async () => {
    compose(["stop", "controller"]);
    try {
      await sleep(3000);
      expect(ping("host-a", HOST_IP.b!)).toBe(true);
      expect(ping("host-d", HOST_IP.c!)).toBe(true);
      expect(httpStatus("host-b", `http://${HOST_IP.d}:8000/`)).toBe(200);
    } finally {
      compose(["start", "controller"]);
    }
    await waitFor("controller API back", async () => (await api("GET", "/api/admin/setup")).status === 200, { timeoutMs: 120_000 });
    // The session survives a restart (sessions are in SQLite).
    expect((await api("GET", "/api/admin/state")).status).toBe(200);
    await waitFor(
      "gateways reporting again",
      async () => (await state()).sites.every((x: any) => x.gateway?.health === "online"),
      { timeoutMs: 120_000, intervalMs: 3000 },
    );
  }, T);

  it("survives a hub reboot: the tunnel comes back from disk before the agent even polls", async () => {
    compose(["restart", "gw-a"]);
    await waitFor(
      "tunnels through A up again",
      async () => {
        const s = await state();
        return s.tunnels.filter((t: any) => t.kind === "direct").every((t: any) => t.health === "up");
      },
      { timeoutMs: 150_000, intervalMs: 3000 },
    );
    // Outbound-only sites re-handshake with the rebooted hub on their next keepalive.
    await waitFor("office reaches the datacentre again", () => ping("host-b", HOST_IP.a!, 2), { timeoutMs: 60_000, intervalMs: 3000 });
    await waitFor("shop reaches the warehouse through the hub again", () => ping("host-d", HOST_IP.c!, 2), { timeoutMs: 90_000, intervalMs: 3000 });
  }, T);

  it("propagates a topology change to every gateway within seconds", async () => {
    // A second VLAN at the office, with a host address and router interface for it.
    mustExec("router-b", "ip addr add 192.168.30.1/24 dev $(ip -o -4 addr show | awk '$4 ~ /^192.168.20/ {print $2; exit}') 2>/dev/null || true");
    mustExec("host-b", "ip addr add 192.168.30.20/24 dev $(ip -o -4 addr show | awk '$4 ~ /^192.168.20/ {print $2; exit}') 2>/dev/null || true");
    await must("POST", `/api/admin/sites/${sites.b.id}/lans`, { cidr: "192.168.30.0/24", name: "Voice", vlan: 30 });
    const started = Date.now();
    await waitConfigCurrent("all gateways applied the new LAN", 60_000);
    console.log(`config change applied everywhere in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    // The router page now includes the new subnet; apply it where routes are required.
    for (const key of ["a", "d"] as const) {
      const plan = (await must<any>("GET", `/api/admin/sites/${sites[key].id}/router`)).plan;
      expect(plan.routes.map((r: any) => r.cidr)).toContain("192.168.30.0/24");
      applyRouterPlan(key, plan);
    }
    expect(ping("host-a", "192.168.30.20")).toBe(true);
    expect(ping("host-d", "192.168.30.20")).toBe(true);
  }, T);

  it("streams live throughput to the dashboard while traffic flows", async () => {
    execDetached("host-a", `iperf3 -c ${HOST_IP.b} -t 15 >/tmp/iperf-live.log 2>&1`);
    await sleep(7000);
    const res = await fetch(`${API}/api/admin/live`, { headers: { cookie: getCookie() }, signal: AbortSignal.timeout(20_000) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let buf = "";
    let payload: any = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const ev of events) {
        const line = ev.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          const p = JSON.parse(line.slice(6));
          const ab = p.tunnels.find((t: any) => [t.a, t.b].sort().join() === [sites.a.id, sites.b.id].sort().join());
          if (ab && (ab.aToB > 100_000 || ab.bToA > 100_000)) payload = p;
        }
      }
      if (payload) break;
    }
    await reader.cancel();
    expect(payload, "a live event with A↔B throughput above 100 kB/s").not.toBeNull();
    const pair = payload.pairs.find((p: any) => p.fromSiteId === sites.a.id && p.toSiteId === sites.b.id);
    expect(pair.bps).toBeGreaterThan(0);
    expect(payload.headline.level).toBe("ok");
  }, T);

  it("roaming client: invite link → config → reaches every site, honours disable and restriction", async () => {
    const client = await must<any>("POST", "/api/admin/clients", { name: "Sim laptop", owner: "sim@example.com" });
    const inv = await must<any>("POST", `/api/admin/clients/${client.id}/invite`, {});
    const token = inv.url.split("/").pop();
    const peek = await api("GET", `/api/invite/${token}`);
    expect(peek.status).toBe(200);
    const pickup = await must<any>("POST", `/api/invite/${token}`);
    expect(pickup.conf).toContain("[Peer]");
    expect((await api("POST", `/api/invite/${token}`)).status).toBe(404); // single use
    writeState("client/client.conf", pickup.conf);
    await waitConfigCurrent("gateways know the client");
    await waitFor("client reaches the datacentre", () => ping("client", HOST_IP.a!, 2), { timeoutMs: 60_000, intervalMs: 3000 });
    for (const key of ["b", "c", "d"] as const) expect(ping("client", HOST_IP[key]!), `client → host-${key}`).toBe(true);
    expect(httpStatus("client", `http://${HOST_IP.b}:8000/`)).toBe(200);
    expect(mustExec("host-b", "cat /var/log/http.log")).toContain("10.99.1.1 - -");
    // Sites cannot open connections to the client.
    expect(ping("host-a", "10.99.1.1", 2)).toBe(false);
    await waitFor(
      "client shows online in the dashboard",
      async () => (await state()).clients.find((c: any) => c.id === client.id)?.online === true,
      { timeoutMs: 60_000, intervalMs: 3000 },
    );

    // Disable: the peer disappears from every gateway.
    await must("PATCH", `/api/admin/clients/${client.id}`, { enabled: false });
    await waitConfigCurrent("gateways dropped the client");
    expect(ping("client", HOST_IP.a!, 2)).toBe(false);

    // Restrict to the office only, with a fresh config.
    await must("PATCH", `/api/admin/clients/${client.id}`, { enabled: true, allowedSiteIds: [sites.b.id] });
    await waitConfigCurrent("gateways applied the restriction");
    const conf = await api<string>("GET", `/api/admin/clients/${client.id}/config`);
    expect(conf.status).toBe(200);
    expect(conf.body).not.toContain("10.0.1.0/24");
    writeState("client/client.conf", conf.body);
    await waitFor("client reaches the office", () => ping("client", HOST_IP.b!, 2), { timeoutMs: 60_000, intervalMs: 3000 });
    expect(ping("client", HOST_IP.a!, 2)).toBe(false);
    expect(ping("client", HOST_IP.d!, 2)).toBe(false);
  }, T);

  it("health checks still pass with a roaming client connected (its /32 route must not shadow the router probe)", async () => {
    // The client is restricted to the office and connected through it, so the
    // office gateway now holds a tunnel route for 10.99.1.1, the very address
    // the router probe for the client range uses.
    for (const key of ["b", "a"] as const) {
      await must("POST", `/api/admin/sites/${sites[key].id}/diagnostics`, {});
      const d = await waitFor(
        `gateway ${key} answered the health checks`,
        async () => {
          const r = await must<any>("GET", `/api/admin/sites/${sites[key].id}/diagnostics`);
          return r.pending ? null : r;
        },
        { timeoutMs: 90_000, intervalMs: 2000 },
      );
      const all = [...d.controller, ...d.agent];
      expect(all.filter((c: any) => c.status === "fail"), `${key}: ${JSON.stringify(all.filter((c: any) => c.status !== "pass"))}`).toEqual([]);
      expect(d.agent.find((c: any) => c.id === "router-route:10.99.1.0/24")?.status, `${key}: client range probe`).toBe("pass");
    }
    // The probe leaves no policy routing behind.
    expect(mustExec("gw-b", "ip rule show")).not.toContain("lookup 250");
    expect(mustExec("gw-b", "ip route show table 250 2>/dev/null || true").trim()).toBe("");
  }, T);

  afterAll(() => {
    // Leave the simulation running for inspection; `npm run sim:down` tears it down.
  });
});
