import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { buildAgentRequest, controllerChecks, pendingAgentRequest, probeIpFor, requestDiagnostics, siteDiagnostics, storeAgentReport } from "@/server/diagnostics";
import { addLan, createEnrolToken, createSite, enrolGateway, getSite, updateGateway } from "@/server/sites";
import { ingestTelemetry } from "@/server/telemetry";
import { liveState, telemetrySchema } from "@/server/live";
import { generateKeyPair } from "@/core/crypto";
import { getGenerated } from "@/server/snapshot";

let now = 1_800_000_000_000;

function enrol(siteId: string, lanIp: string) {
  const { token } = createEnrolToken(siteId);
  const r = enrolGateway({ token, publicKey: generateKeyPair().publicKey, hostname: "gw", os: "", arch: "", addresses: [lanIp], agentVersion: "1" });
  if (!r.ok) throw new Error(r.reason);
  return getSite(siteId)!.gateway!;
}

/** A report that claims the configuration currently generated for the gateway is applied. */
function report(gw: { id: string }, peers: Array<{ publicKey: string; handshakeAgeS: number | null; rttMs?: number }>, extra: Record<string, unknown> = {}) {
  return telemetrySchema.parse({
    version: "1",
    appliedHash: getGenerated().bundle.gateways[gw.id]?.hash ?? "",
    interfaceUp: true,
    peers: peers.map((p) => ({ publicKey: p.publicKey, endpoint: null, latestHandshake: p.handshakeAgeS === null ? 0 : Math.floor(now / 1000) - p.handshakeAgeS, rxBytes: 0, txBytes: 0, rttMs: p.rttMs ?? null })),
    counters: [],
    ...extra,
  });
}

beforeEach(() => {
  freshDb();
  liveState().resetFastModeForTests();
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

function twoSites() {
  const dc = createSite({ name: "Datacentre", routerLayout: "transit", hubPriority: 1 }, "t");
  addLan(dc.id, { cidr: "10.0.1.0/24", name: "Servers" }, "t");
  const shop = createSite({ name: "Shop", routerLayout: "masquerade", hubPriority: 2 }, "t");
  addLan(shop.id, { cidr: "10.40.0.0/24", name: "Floor" }, "t");
  const gwDc = enrol(dc.id, "10.0.250.2");
  const gwShop = enrol(shop.id, "10.40.0.2");
  updateGateway(dc.id, { endpointHost: "dc.example.com" }, "t");
  return { dc, shop, gwDc: getSite(dc.id)!.gateway!, gwShop, dcKey: gwDc.publicKey, shopKey: gwShop.publicKey };
}

describe("probe addresses", () => {
  it("picks the first host of a network", () => {
    expect(probeIpFor("10.0.1.0/24")).toBe("10.0.1.1");
    expect(probeIpFor("192.168.20.0/22")).toBe("192.168.20.1");
    expect(probeIpFor("10.99.1.5/32")).toBe("10.99.1.5");
    // Never one of the gateway's own addresses: the kernel would deliver the
    // probe locally instead of handing it to the router.
    expect(probeIpFor("10.99.0.0/24", ["10.99.0.1"])).toBe("10.99.0.254");
    expect(probeIpFor("10.0.250.0/29", ["10.0.250.1"])).toBe("10.0.250.6");
    expect(probeIpFor("10.99.0.0/24", ["10.99.0.7"])).toBe("10.99.0.1");
  });

  it("steers the gateway-range probe away from the gateway's own tunnel address", () => {
    const { gwDc } = twoSites();
    const a = buildAgentRequest(gwDc, "1");
    const gwRange = a.remoteNets.find((n) => n.cidr === "10.99.0.0/24")!;
    expect(gwRange.ip).not.toBe(gwDc.tunnelIp);
    expect([gwDc.tunnelIp === "10.99.0.1" ? "10.99.0.254" : "10.99.0.1"]).toContain(gwRange.ip);
  });
});

describe("agent request", () => {
  it("describes what the gateway must test, per layout", () => {
    const { dc, shop, gwDc, gwShop } = twoSites();
    const a = buildAgentRequest(gwDc, "1");
    expect(a.routerTest).toBe(true);
    expect(a.lanIp).toBe("10.0.250.2");
    expect(a.remoteNets.map((n) => n.cidr)).toContain("10.40.0.0/24");
    expect(a.remoteNets.find((n) => n.cidr === "10.40.0.0/24")?.ip).toBe("10.40.0.1");
    // Only remote LANs are expected in the gateway's own route table; the
    // router must still route the tunnel ranges, so they stay in the list.
    expect(a.remoteNets.find((n) => n.cidr === "10.40.0.0/24")?.tunnelRoute).toBe(true);
    expect(a.remoteNets.find((n) => n.cidr === "10.99.1.0/24")?.tunnelRoute).toBe(false);
    expect(a.remoteNets.find((n) => n.cidr === "10.99.0.0/24")?.tunnelRoute).toBe(false);
    expect(a.mtuTargets).toEqual([{ ip: gwShop.tunnelIp, label: "Shop" }]);
    expect(a.endpointHosts).toEqual([]); // the shop has no public name
    expect(a.listenPort).toBe(51820);
    expect(a.mtu).toBe(1420);
    const b = buildAgentRequest(gwShop, "2");
    expect(b.routerTest).toBe(false); // masquerade: routes optional
    expect(b.remoteNets.map((n) => n.cidr)).toContain("10.0.1.0/24");
    expect(b.endpointHosts).toEqual([{ host: "dc.example.com", label: "Datacentre" }]);
    expect(b.mtuTargets[0]!.ip).toBe(getSite(dc.id)!.gateway!.tunnelIp);
    expect(shop.id).not.toBe(dc.id);
  });

  it("is handed out while a request is outstanding, then cleared by the gateway's answer", () => {
    const { dc } = twoSites();
    expect(pendingAgentRequest(getSite(dc.id)!.gateway!)).toBeNull();
    const r = requestDiagnostics(dc.id, "admin@example.com")!;
    expect(r.requestedAt).toBe(now);
    const gw = getSite(dc.id)!.gateway!;
    const req = pendingAgentRequest(gw);
    expect(req?.id).toBe(String(now));
    // A stale answer to an older request is ignored.
    expect(storeAgentReport(gw, { id: "old", ranAt: now, checks: [] })).toBe(false);
    expect(storeAgentReport(gw, { id: req!.id, ranAt: now, checks: [{ id: "forwarding", status: "pass", title: "IP forwarding is on", detail: "" }] })).toBe(true);
    expect(pendingAgentRequest(getSite(dc.id)!.gateway!)).toBeNull();
    expect(requestDiagnostics("nope", "admin@example.com")).toBeNull();
  });

  it("gives up waiting after two minutes", async () => {
    const { dc } = twoSites();
    requestDiagnostics(dc.id, "admin@example.com");
    now += 121_000;
    expect(pendingAgentRequest(getSite(dc.id)!.gateway!)).toBeNull();
    const d = await siteDiagnostics(dc.id);
    expect(d.pending).toBe(false);
    expect(d.agentUnanswered).toBe(true);
  });
});

describe("controller checks", () => {
  it("passes for a healthy pair, including the dial-in proof", async () => {
    const { dc, shop, gwDc, gwShop, dcKey, shopKey } = twoSites();
    ingestTelemetry(gwDc, report(gwDc, [{ publicKey: shopKey, handshakeAgeS: 10, rttMs: 4 }]));
    ingestTelemetry(gwShop, report(gwShop, [{ publicKey: dcKey, handshakeAgeS: 10, rttMs: 4 }]));
    const a = await controllerChecks(dc.id);
    const byId = Object.fromEntries(a.map((c) => [c.id, c]));
    expect(byId.reporting?.status).toBe("pass");
    expect(byId.config?.status).toBe("pass");
    expect(byId[`tunnel:${shop.id}`]?.status).toBe("pass");
    expect(byId.inbound?.status).toBe("pass");
    expect(byId.inbound?.detail).toContain("Shop");
    const b = await controllerChecks(shop.id);
    expect(b.find((c) => c.id === "inbound")?.status).toBe("skip");
    expect(b.find((c) => c.id === `tunnel:${dc.id}`)?.status).toBe("pass");
  });

  it("names the port forward when a dialer reaches other sites but not this one", async () => {
    const { dc, gwDc, gwShop, dcKey, shopKey } = twoSites();
    // A third, reachable site the shop does reach.
    const office = createSite({ name: "Office", routerLayout: "same_lan", hubPriority: 3 }, "t");
    addLan(office.id, { cidr: "192.168.20.0/24", name: "Staff" }, "t");
    const gwOffice = enrol(office.id, "192.168.20.2");
    updateGateway(office.id, { endpointHost: "203.0.113.5" }, "t");
    const officeKey = gwOffice.publicKey;
    ingestTelemetry(gwDc, report(gwDc, [{ publicKey: shopKey, handshakeAgeS: null }, { publicKey: officeKey, handshakeAgeS: 5, rttMs: 2 }]));
    ingestTelemetry(gwShop, report(gwShop, [{ publicKey: dcKey, handshakeAgeS: null }, { publicKey: officeKey, handshakeAgeS: 5, rttMs: 9 }]));
    const gwOff = getSite(office.id)!.gateway!;
    ingestTelemetry(gwOff, report(gwOff, [{ publicKey: dcKey, handshakeAgeS: 5, rttMs: 2 }, { publicKey: shopKey, handshakeAgeS: 5, rttMs: 9 }]));
    const a = await controllerChecks(dc.id);
    const inbound = a.find((c) => c.id === "inbound")!;
    expect(inbound.status).toBe("fail");
    expect(inbound.detail).toContain("Shop");
    expect(inbound.hint).toContain("UDP 51820");
    expect(inbound.hint).toContain("10.0.250.2");
    const tunnel = a.find((c) => c.id === `tunnel:${gwShop.siteId}`)!;
    expect(tunnel.status).toBe("fail");
    expect(tunnel.hint).toContain("dc.example.com");
  });

  it("reports late and missing gateways, and failed configuration", async () => {
    const { dc, gwDc, shopKey } = twoSites();
    ingestTelemetry(gwDc, report(gwDc, [{ publicKey: shopKey, handshakeAgeS: 10, rttMs: 1 }], { lastError: "nft: syntax error" }));
    let a = await controllerChecks(dc.id);
    expect(a.find((c) => c.id === "config")?.status).toBe("fail");
    expect(a.find((c) => c.id === "config")?.detail).toContain("nft: syntax error");
    now += 5 * 60_000;
    a = await controllerChecks(dc.id);
    expect(a.find((c) => c.id === "reporting")?.status).toBe("fail");
    const untouched = createSite({ name: "Empty", routerLayout: "transit", hubPriority: 9 }, "t");
    expect((await controllerChecks(untouched.id))[0]?.status).toBe("skip");
  });
});
