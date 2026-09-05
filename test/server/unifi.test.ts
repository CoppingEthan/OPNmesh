import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./helpers";
import { startFakeConsole, type FakeConsole } from "./fake-unifi";
import { UnifiClient } from "@/server/unifi/client";
import { desiredRoutes, planRoutes, syncSite, removeAll, desiredPolicy } from "@/server/unifi/reconcile";
import { probeConsole, saveLink, syncLink, unlink, getLink, linkView } from "@/server/unifi";
import { addLan, createEnrolToken, createSite, enrolGateway, updateGateway, removeLan, getSite } from "@/server/sites";
import { getGenerated } from "@/server/snapshot";
import { generateKeyPair } from "@/core/crypto";
import { scenarios } from "../fixtures/snapshots";
import { generateRouterPlan } from "@/core/generate/router";

let fake: FakeConsole;

beforeAll(async () => {
  fake = await startFakeConsole();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  freshDb();
  fake.routes = fake.routes.filter((r) => r._id === "r-user");
  fake.policies = [];
  fake.portForwards = [];
  fake.requests = [];
});

describe("client", () => {
  it("authenticates with an API key and talks the classic and v2 APIs", async () => {
    const c = new UnifiClient({ baseUrl: fake.url, site: "default", auth: { kind: "api_key", apiKey: fake.apiKey }, pin: null });
    const who = await c.whoami();
    expect(who.name).toBe("opnmesh");
    expect(who.version).toBe("9.3.45");
    expect((await c.listRoutes()).map((r) => r._id)).toEqual(["r-user"]);
    expect((await c.listZones()).map((z) => z.name)).toEqual(["Internal", "External"]);
    const bad = new UnifiClient({ baseUrl: fake.url, site: "default", auth: { kind: "api_key", apiKey: "wrong" }, pin: null });
    await expect(bad.listRoutes()).rejects.toThrow(/refused the credentials/);
  });
  it("logs in with a password and sends the CSRF token on writes", async () => {
    const c = new UnifiClient({ baseUrl: fake.url, site: "default", auth: { kind: "password", ...fake.password }, pin: null });
    await c.login();
    const created = await c.createRoute({ name: "OPNmesh: t", enabled: true, type: "static-route", "static-route_network": "10.9.0.0/24", "static-route_type": "nexthop-route", "static-route_nexthop": "10.0.1.2", "static-route_distance": 1 });
    expect(created._id).toMatch(/^r-/);
    expect(fake.requests.some((r) => r.auth === "cookie" && r.method === "POST")).toBe(true);
    const wrong = new UnifiClient({ baseUrl: fake.url, site: "default", auth: { kind: "password", username: "x", password: "y" }, pin: null });
    await expect(wrong.login()).rejects.toThrow(/login failed/);
  });
});

describe("reconciliation planning", () => {
  const plan = () => generateRouterPlan(scenarios["hub-and-spoke"]!(), "site-office");

  it("derives one managed route per required destination", () => {
    const d = desiredRoutes(plan());
    expect(d.map((r) => r["static-route_network"])).toEqual(["10.0.1.0/24", "10.30.0.0/24", "10.99.0.0/24", "10.99.1.0/24"]);
    expect(d.every((r) => r.name.startsWith("OPNmesh:") && r["static-route_nexthop"] === "192.168.20.2" && r["static-route_distance"] === 1)).toBe(true);
    // Masquerade sites need no routes.
    expect(desiredRoutes(generateRouterPlan(scenarios["hub-and-spoke"]!(), "site-warehouse"))).toEqual([]);
  });
  it("creates, updates, keeps and deletes only OPNmesh routes", () => {
    const desired = desiredRoutes(plan());
    const existing = [
      { _id: "r-user", name: "Users own route", enabled: true, type: "static-route" as const, "static-route_network": "10.0.1.0/24", "static-route_type": "nexthop-route" as const, "static-route_nexthop": "10.0.1.99", "static-route_distance": 1 },
      { _id: "r-1", name: "OPNmesh: old", enabled: true, type: "static-route" as const, "static-route_network": "10.30.0.0/24", "static-route_type": "nexthop-route" as const, "static-route_nexthop": "192.168.20.9", "static-route_distance": 1 },
      { _id: "r-2", name: "OPNmesh: gone", enabled: true, type: "static-route" as const, "static-route_network": "10.77.0.0/24", "static-route_type": "nexthop-route" as const, "static-route_nexthop": "192.168.20.2", "static-route_distance": 1 },
      { ...desired[3]!, _id: "r-3" },
    ];
    const steps = planRoutes(existing, desired, { routes: {} });
    const by = (a: string) => steps.filter((s) => s.action === a).map((s) => s.route["static-route_network"]);
    expect(by("create")).toEqual(["10.0.1.0/24", "10.99.0.0/24"]); // user's own 10.0.1.0/24 is not ours
    expect(by("update")).toEqual(["10.30.0.0/24"]);
    expect(by("keep")).toEqual(["10.99.1.0/24"]);
    expect(by("delete")).toEqual(["10.77.0.0/24"]);
  });
  it("builds the same-LAN policy against the Internal zone", () => {
    const p = desiredPolicy(plan(), [{ _id: "z1", name: "Internal" }]);
    expect(p?.destination.ips).toEqual(plan().allStatesPolicy!.destinations);
    expect(p?.connection_state_type).toBe("ALL");
    expect(desiredPolicy(generateRouterPlan(scenarios["hub-and-spoke"]!(), "site-dc"), [{ _id: "z1", name: "Internal" }])).toBeNull();
  });
});

describe("sync against the fake console", () => {
  it("converges, is idempotent, and cleans up", async () => {
    const c = new UnifiClient({ baseUrl: fake.url, site: "default", auth: { kind: "api_key", apiKey: fake.apiKey }, pin: null });
    const p = generateRouterPlan(scenarios["hub-and-spoke"]!(), "site-office");
    const r1 = await syncSite(c, p, { routes: {} });
    expect([r1.created, r1.updated, r1.deleted]).toEqual([4, 0, 0]);
    expect(r1.policy).toBe("created");
    expect(r1.portForwardPresent).toBe(false);
    expect(r1.warnings[0]).toContain("port forward");
    expect(fake.routes).toHaveLength(5);
    expect(fake.policies).toHaveLength(1);

    const r2 = await syncSite(c, p, r1.managed);
    expect([r2.created, r2.updated, r2.deleted, r2.unchanged]).toEqual([0, 0, 0, 4]);
    expect(r2.policy).toBe("unchanged");

    // A changed topology updates and prunes.
    const p2 = { ...p, routes: p.routes.filter((r) => r.cidr !== "10.30.0.0/24"), nextHop: "192.168.20.3" };
    const r3 = await syncSite(c, p2, r2.managed);
    expect([r3.created, r3.updated, r3.deleted]).toEqual([0, 3, 1]);
    expect(fake.routes.find((r) => r._id === "r-user")).toBeDefined();
    expect(fake.routes.filter((r) => r.name.startsWith("OPNmesh:")).every((r) => r["static-route_nexthop"] === "192.168.20.3")).toBe(true);

    fake.portForwards.push({ _id: "pf1", name: "wg", enabled: true, proto: "udp", dst_port: "51820", fwd: "192.168.20.2", fwd_port: "51820" });
    const r4 = await syncSite(c, p, r3.managed);
    expect(r4.portForwardPresent).toBe(true);

    const removed = await removeAll(c, r4.managed);
    expect(removed.deleted).toBe(5);
    expect(fake.routes.map((r) => r._id)).toEqual(["r-user"]);
    expect(fake.policies).toHaveLength(0);
  });
});

describe("links through the server layer", () => {
  it("probes, saves sealed credentials, syncs on demand and unlinks", async () => {
    const site = createSite({ name: "Office", routerLayout: "same_lan", hubPriority: 2 });
    addLan(site.id, { cidr: "192.168.20.0/24", name: "Staff" });
    const dc = createSite({ name: "DC", hubPriority: 1 });
    addLan(dc.id, { cidr: "10.0.1.0/24", name: "Servers" });
    for (const s of [site, dc]) {
      const { token } = createEnrolToken(s.id);
      const r = enrolGateway({ token, publicKey: generateKeyPair().publicKey, hostname: s.slug, os: "", arch: "", addresses: [s.id === site.id ? "192.168.20.2" : "10.0.250.2"], agentVersion: "" });
      if (!r.ok) throw new Error(r.reason);
      updateGateway(s.id, { endpointHost: `${s.slug}.example.com` });
    }
    const probe = await probeConsole({ baseUrl: fake.url, unifiSite: "default", auth: { kind: "api_key", apiKey: fake.apiKey } });
    expect(probe.certificate).toBeNull(); // plain http in tests
    expect(probe.identity?.version).toBe("9.3.45");
    expect(probe.error).toBeNull();

    saveLink(site.id, { baseUrl: fake.url, unifiSite: "default", auth: { kind: "api_key", apiKey: fake.apiKey }, certFingerprint: null, certPem: null });
    const view = linkView(getLink(site.id)!);
    expect(view.authKind).toBe("api_key");
    expect(JSON.stringify(view)).not.toContain(fake.apiKey);

    const res = await syncLink(site.id, "admin");
    expect(res.created).toBe(3); // DC's LAN, the gateway range, the client range
    expect(getLink(site.id)!.lastSyncStatus).toBe("warning"); // no port forward on the fake console
    expect(getLink(site.id)!.lastSyncDetail).toContain("3 created");

    // Topology change → next sync updates the console.
    const lanId = getSite(dc.id)!.lans[0]!.id;
    addLan(dc.id, { cidr: "10.0.2.0/24", name: "More" });
    const res2 = await syncLink(site.id, "admin");
    expect(res2.created).toBe(1);
    removeLan(dc.id, lanId);
    const res3 = await syncLink(site.id, "admin");
    expect(res3.deleted).toBe(1);
    expect(getGenerated().bundle.routers[site.id]!.routes.map((r) => r.cidr)).toContain("10.0.2.0/24");

    const out = await unlink(site.id, true, "admin");
    expect(out.deleted).toBeGreaterThanOrEqual(4);
    expect(getLink(site.id)).toBeNull();
    expect(fake.routes.map((r) => r._id)).toEqual(["r-user"]);
  });
});
