import { createServer } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { startFakeConsole, type FakeConsole } from "./fake-unifi";
import { makeCa, makeServerCert, type TestCa, type TestCert } from "./test-certs";
import { fetchConsoleCertificate, MAX_RESPONSE_BYTES, setExtraCaForTests, UnifiClient, UnifiError, type UnifiRoute } from "@/server/unifi/client";
import { desiredRoutes, planRoutes, syncSite, removeAll, desiredPolicy } from "@/server/unifi/reconcile";
import { probeConsole, resetUnifiScheduleForTests, saveLink, syncDueLinks, syncLink, unlink, getLink, linkView } from "@/server/unifi";
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
  fake.intercept = undefined;
  resetUnifiScheduleForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  setExtraCaForTests(undefined);
});

const keyClient = (c: FakeConsole, extra: Partial<ConstructorParameters<typeof UnifiClient>[0]> = {}) => new UnifiClient({ baseUrl: c.url, site: "default", auth: { kind: "api_key", apiKey: c.apiKey }, pin: null, ...extra });

/** An Office (same-LAN) and a DC site, both with an active gateway, so both have a router plan. */
function twoSites() {
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
  return { site, dc };
}

describe("client", () => {
  it("authenticates with an API key and talks the classic and v2 APIs", async () => {
    const c = keyClient(fake);
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
    await expect(wrong.login()).rejects.toThrow(/^authentication failed \(HTTP 401\)$/);
  });

  it("reports what went wrong as a category, never with the remote end's text", async () => {
    const secret = "internal wiki: payroll";
    let mode = "html";
    fake.intercept = (_req, res) => {
      if (mode === "html") res.writeHead(200, { "content-type": "text/html" }).end(`<title>${secret}</title>`);
      else if (mode === "404") res.writeHead(404, { "content-type": "text/html" }).end(secret);
      else if (mode === "rc") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ meta: { rc: "error", msg: secret }, data: [] }));
      else if (mode === "rc-unifi") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ meta: { rc: "error", msg: "api.err.IdInvalid" }, data: [] }));
      else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ secret }));
      return true;
    };
    const c = keyClient(fake);
    const failure = async () => (await c.listRoutes().catch((e: unknown) => e)) as UnifiError;
    const cases: Array<[string, string]> = [
      ["html", "unexpected response from the console (not JSON)"],
      ["404", "unexpected response from the console (HTTP 404)"],
      ["rc", "the console reported an error"],
      ["rc-unifi", "the console reported an error (api.err.IdInvalid)"],
    ];
    for (const [m, message] of cases) {
      mode = m;
      const e = await failure();
      expect(e).toBeInstanceOf(UnifiError);
      expect(e.message).toBe(message);
      if (m !== "rc-unifi") expect(e.detail).toContain(secret); // for the server log
    }
    mode = "object";
    await expect(c.listZones()).rejects.toThrow(/^unexpected response from the console \(not a list\)$/);

    // A closed port.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise((r) => probe.close(r));
    await expect(new UnifiClient({ baseUrl: `http://127.0.0.1:${port}`, site: "default", auth: { kind: "api_key", apiKey: "k" }, pin: null }).listRoutes()).rejects.toThrow(/^cannot reach the console: connection refused$/);
  });

  it("stops reading an oversized response, declared or streamed", async () => {
    let declared = true;
    fake.intercept = (_req, res) => {
      if (declared) {
        res.writeHead(200, { "content-type": "application/json", "content-length": String(MAX_RESPONSE_BYTES + 1) });
        res.write("[");
        return true;
      }
      // Chunked, never ending on its own: only the cap stops it.
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(256 * 1024, 0x20);
      const pump = () => {
        while (res.write(chunk));
      };
      res.on("drain", pump);
      pump();
      return true;
    };
    const c = keyClient(fake);
    await expect(c.listRoutes()).rejects.toThrow(/^the console's response is too large$/);
    declared = false;
    const started = Date.now();
    await expect(c.listRoutes()).rejects.toThrow(/^the console's response is too large$/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("gives up on a console that trickles its answer, however steadily", async () => {
    fake.intercept = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write(" "), 20);
      res.on("close", () => clearInterval(t));
      return true;
    };
    const started = Date.now();
    // The idle timeout never fires; the deadline does.
    await expect(keyClient(fake, { timeoutMs: 5_000, deadlineMs: 300 }).listRoutes()).rejects.toThrow(/^request to the console timed out$/);
    expect(Date.now() - started).toBeLessThan(3_000);

    const abort = new AbortController();
    const pending = keyClient(fake, { signal: abort.signal }).listRoutes();
    setTimeout(() => abort.abort(new UnifiError("stop now")), 100);
    await expect(pending).rejects.toThrow(/^stop now$/);
    await expect(keyClient(fake, { signal: abort.signal }).listRoutes()).rejects.toThrow(/^stop now$/);
  });
});

describe("console certificates", () => {
  let ca: TestCa;
  let selfSigned: TestCert;
  let publicCert: TestCert;
  let consoleSelf: FakeConsole;
  let consolePublic: FakeConsole;
  let consoleWrongName: FakeConsole;

  beforeAll(async () => {
    ca = makeCa();
    selfSigned = makeServerCert(["127.0.0.1"]);
    publicCert = makeServerCert(["127.0.0.1"], ca);
    consoleSelf = await startFakeConsole({ tls: selfSigned });
    consolePublic = await startFakeConsole({ tls: publicCert });
    consoleWrongName = await startFakeConsole({ tls: makeServerCert(["unifi.example.com"], ca) });
  });
  afterAll(async () => {
    await Promise.all([consoleSelf.close(), consolePublic.close(), consoleWrongName.close()]);
  });

  it("pins a self-signed console and refuses any other certificate", async () => {
    const cert = await fetchConsoleCertificate(consoleSelf.url);
    expect(cert.systemTrusted).toBe(false);
    expect(cert.fingerprint).toBe(selfSigned.fingerprint);
    expect(cert.subject).toContain("127.0.0.1");

    expect((await keyClient(consoleSelf, { pin: { fingerprint: cert.fingerprint, pem: cert.pem } }).whoami()).name).toBe("opnmesh");
    // Pinned to another certificate.
    await expect(keyClient(consoleSelf, { pin: { fingerprint: publicCert.fingerprint, pem: publicCert.cert } }).whoami()).rejects.toThrow(/^cannot reach the console: certificate does not match the pinned fingerprint$/);
    // Unpinned, a self-signed certificate is not trusted.
    await expect(keyClient(consoleSelf).whoami()).rejects.toThrow(/^cannot reach the console: certificate is not trusted$/);
  });

  it("checks an unpinned console against the trusted CAs and its host name, and never accepts just any certificate", async () => {
    // Without the test CA standing in for a public one, nothing is trusted.
    expect((await fetchConsoleCertificate(consolePublic.url)).systemTrusted).toBe(false);
    await expect(keyClient(consolePublic).whoami()).rejects.toThrow(/certificate is not trusted/);

    setExtraCaForTests([ca.cert]);
    expect((await fetchConsoleCertificate(consolePublic.url)).systemTrusted).toBe(true);
    expect((await keyClient(consolePublic).whoami()).name).toBe("opnmesh");
    // Right CA, wrong name.
    expect((await fetchConsoleCertificate(consoleWrongName.url)).systemTrusted).toBe(false);
    await expect(keyClient(consoleWrongName).whoami()).rejects.toThrow(/^cannot reach the console: certificate does not match the host name$/);
  });

  it("links and syncs a console in either mode, and the view says which", async () => {
    const { site, dc } = twoSites();
    const auth = (c: FakeConsole) => ({ kind: "api_key" as const, apiKey: c.apiKey });
    consoleSelf.requests = [];

    // Pinned (the default).
    const probe = await probeConsole({ baseUrl: consoleSelf.url, unifiSite: "default", auth: auth(consoleSelf) });
    expect(probe.certificate?.systemTrusted).toBe(false);
    expect(probe.identity).toBeNull(); // no credentials sent before the admin confirms
    expect(consoleSelf.requests).toHaveLength(0);
    const confirmed = await probeConsole({ baseUrl: consoleSelf.url, unifiSite: "default", auth: auth(consoleSelf), trustFingerprint: probe.certificate!.fingerprint });
    expect(confirmed.identity?.name).toBe("opnmesh");
    expect(() => saveLink(site.id, { baseUrl: consoleSelf.url, unifiSite: "default", auth: auth(consoleSelf), certFingerprint: null, certPem: null })).toThrow(/confirm the console certificate/);
    expect(() => saveLink(site.id, { baseUrl: consoleSelf.url, unifiSite: "default", auth: auth(consoleSelf), certFingerprint: publicCert.fingerprint, certPem: probe.certificate!.pem })).toThrow(/does not match its fingerprint/);
    saveLink(site.id, { baseUrl: consoleSelf.url, unifiSite: "default", auth: auth(consoleSelf), certFingerprint: probe.certificate!.fingerprint.toUpperCase(), certPem: probe.certificate!.pem });
    expect(linkView(getLink(site.id)!)).toMatchObject({ certMode: "pinned", certFingerprint: selfSigned.fingerprint });
    expect((await syncLink(site.id, "admin")).created).toBe(3);

    // Public certificate: no pin, system CAs and host name.
    setExtraCaForTests([ca.cert]);
    const pub = await probeConsole({ baseUrl: consolePublic.url, unifiSite: "default", auth: auth(consolePublic) });
    expect(pub.certificate?.systemTrusted).toBe(true);
    expect(pub.identity?.name).toBe("opnmesh");
    expect(() => saveLink(dc.id, { baseUrl: consolePublic.url, unifiSite: "default", auth: auth(consolePublic), certMode: "system", certFingerprint: pub.certificate!.fingerprint, certPem: pub.certificate!.pem })).toThrow(/not pinned/);
    saveLink(dc.id, { baseUrl: consolePublic.url, unifiSite: "default", auth: auth(consolePublic), certMode: "system", certFingerprint: null, certPem: null });
    expect(linkView(getLink(dc.id)!)).toMatchObject({ certMode: "system", certFingerprint: null });
    await syncLink(dc.id, "admin");
    expect(getLink(dc.id)!.lastSyncStatus).not.toBe("error");
    // Should the certificate stop being trusted, the sync fails rather than carrying on.
    setExtraCaForTests(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(syncLink(dc.id, "admin")).rejects.toThrow(/certificate is not trusted/);
  });

  it("probes without handing back the console's pages, and logs the detail on one line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleSelf.intercept = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end("<title>Grafana</title>\r\nsecret dashboard");
      return true;
    };
    try {
      const out = await probeConsole({ baseUrl: consoleSelf.url, unifiSite: "default", auth: { kind: "api_key", apiKey: "k" }, trustFingerprint: selfSigned.fingerprint });
      // The certificate is still shown, since confirming it is the point of the probe.
      expect(out.certificate?.fingerprint).toBe(selfSigned.fingerprint);
      expect(out.error).toBe("unexpected response from the console (not JSON)");
      expect(JSON.stringify(out)).not.toMatch(/Grafana|secret/);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]![0]);
      expect(line).toContain("Grafana");
      expect(line).not.toMatch(/[\r\n]/);
    } finally {
      consoleSelf.intercept = undefined;
    }

    // Something that does not speak TLS at all.
    await expect(probeConsole({ baseUrl: fake.url.replace("http:", "https:"), unifiSite: "default", auth: { kind: "api_key", apiKey: "k" } })).rejects.toThrow(/^cannot reach the console: TLS handshake failed$/);
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe("reconciliation planning", () => {
  const plan = () => generateRouterPlan(scenarios["hub-and-spoke"]!(), "site-office");
  const route = (id: string, name: string, cidr: string, nextHop: string): UnifiRoute => ({ _id: id, name, enabled: true, type: "static-route", "static-route_network": cidr, "static-route_type": "nexthop-route", "static-route_nexthop": nextHop, "static-route_distance": 1 });

  it("derives one managed route per required destination", () => {
    const d = desiredRoutes(plan());
    expect(d.map((r) => r["static-route_network"])).toEqual(["10.0.1.0/24", "10.30.0.0/24", "10.99.0.0/24", "10.99.1.0/24"]);
    expect(d.every((r) => r.name.startsWith("OPNmesh:") && r["static-route_nexthop"] === "192.168.20.2" && r["static-route_distance"] === 1)).toBe(true);
    // Masquerade sites need no routes.
    expect(desiredRoutes(generateRouterPlan(scenarios["hub-and-spoke"]!(), "site-warehouse"))).toEqual([]);
  });
  it("creates, updates, keeps and deletes only the routes it recorded", () => {
    const desired = desiredRoutes(plan());
    const existing = [
      route("r-user", "Users own route", "10.0.1.0/24", "10.0.1.99"),
      route("r-1", "OPNmesh: old", "10.30.0.0/24", "192.168.20.9"),
      route("r-2", "OPNmesh: gone", "10.77.0.0/24", "192.168.20.2"),
      { ...desired[3]!, _id: "r-3" },
    ];
    const steps = planRoutes(existing, desired, { routes: { "10.30.0.0/24": "r-1", "10.77.0.0/24": "r-2", "10.99.1.0/24": "r-3" } });
    const by = (a: string) => steps.filter((s) => s.action === a).map((s) => s.route["static-route_network"]);
    expect(by("create")).toEqual(["10.0.1.0/24", "10.99.0.0/24"]); // user's own 10.0.1.0/24 is not ours
    expect(by("update")).toEqual(["10.30.0.0/24"]);
    expect(by("keep")).toEqual(["10.99.1.0/24"]);
    expect(by("delete")).toEqual(["10.77.0.0/24"]);
  });
  it("never takes over an unrecorded OPNmesh route unless it is exactly one the plan wants", () => {
    const desired = desiredRoutes(plan());
    const existing = [
      route("r-other", "OPNmesh: another controller", "10.30.0.0/24", "192.168.20.9"), // same network, other next hop
      route("r-stale", "OPNmesh: gone", "10.77.0.0/24", "192.168.20.2"), // not wanted at all
      route("r-hand", "OPNmesh: typed in by hand", "10.0.1.0/24", "192.168.20.2"), // exactly wanted
      route("r-plain", "DC by hand", "10.99.0.0/24", "192.168.20.2"), // exactly wanted, but not named as ours
    ];
    const steps = planRoutes(existing, desired, { routes: {} });
    const ids = (a: string) => steps.filter((s) => s.action === a).map((s) => s.id);
    expect(ids("delete")).toEqual([]);
    expect(ids("update")).toEqual(["r-hand"]); // renamed to the plan's name
    expect(steps.filter((s) => s.action === "create").map((s) => s.route["static-route_network"])).toEqual(["10.30.0.0/24", "10.99.0.0/24", "10.99.1.0/24"]);
    expect(steps.some((s) => s.id === "r-other" || s.id === "r-stale" || s.id === "r-plain")).toBe(false);
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
    const c = keyClient(fake);
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

  it("leaves OPNmesh-named routes and policies it did not create alone, through sync and unlink", async () => {
    const c = keyClient(fake);
    const p = generateRouterPlan(scenarios["hub-and-spoke"]!(), "site-office");
    const foreign = [
      { _id: "r-other", name: "OPNmesh: Warehouse LAN", enabled: true, type: "static-route", "static-route_network": "10.30.0.0/24", "static-route_type": "nexthop-route", "static-route_nexthop": "10.0.0.9", "static-route_distance": 1 },
      { _id: "r-mine", name: "OPNmesh: lab", enabled: false, type: "static-route", "static-route_network": "172.20.0.0/16", "static-route_type": "nexthop-route", "static-route_nexthop": "10.0.1.50", "static-route_distance": 5 },
    ];
    fake.routes.push(...foreign.map((r) => ({ ...r })));
    fake.routes.push({ _id: "r-hand", name: "Datacentre (typed in)", enabled: true, type: "static-route", "static-route_network": "10.0.1.0/24", "static-route_type": "nexthop-route", "static-route_nexthop": "192.168.20.2", "static-route_distance": 1 });
    fake.routes.push({ _id: "r-hand2", name: "OPNmesh: Datacentre", enabled: true, type: "static-route", "static-route_network": "10.0.1.0/24", "static-route_type": "nexthop-route", "static-route_nexthop": "192.168.20.2", "static-route_distance": 1 });
    const theirPolicy = { ...desiredPolicy(p, fake.zones)!, _id: "p-other", destination: { zone_id: "z-int", matching_target: "IP", ips: ["10.200.0.0/24"] } };
    fake.policies.push(structuredClone(theirPolicy));

    const r1 = await syncSite(c, p, { routes: {} });
    expect(r1.deleted).toBe(0);
    expect(r1.managed.routes["10.0.1.0/24"]).toBe("r-hand2"); // exactly the wanted route, so adopted
    expect(r1.created).toBe(3);
    expect(r1.policy).toBe("created");
    expect(r1.managed.policy).not.toBe("p-other");
    const r2 = await syncSite(c, p, r1.managed);
    expect([r2.created, r2.updated, r2.deleted]).toEqual([0, 0, 0]);

    await removeAll(c, r2.managed);
    expect(fake.routes.map((r) => r._id).sort()).toEqual(["r-hand", "r-mine", "r-other", "r-user"]);
    for (const f of foreign) expect(fake.routes.find((r) => r._id === f._id)).toEqual(f);
    expect(fake.policies).toEqual([theirPolicy]);
  });
});

describe("links through the server layer", () => {
  it("probes, saves sealed credentials, syncs on demand and unlinks", async () => {
    const { site, dc } = twoSites();
    const probe = await probeConsole({ baseUrl: fake.url, unifiSite: "default", auth: { kind: "api_key", apiKey: fake.apiKey } });
    expect(probe.certificate).toBeNull(); // plain http in tests
    expect(probe.identity?.version).toBe("9.3.45");
    expect(probe.error).toBeNull();

    saveLink(site.id, { baseUrl: fake.url, unifiSite: "default", auth: { kind: "api_key", apiKey: fake.apiKey }, certFingerprint: null, certPem: null });
    const view = linkView(getLink(site.id)!);
    expect(view.authKind).toBe("api_key");
    expect(view.certMode).toBe("none");
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

  describe("background sync", () => {
    let stuck: FakeConsole;
    beforeAll(async () => {
      stuck = await startFakeConsole();
      // Headers, then a space every 20 ms for ever.
      stuck.intercept = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        const t = setInterval(() => res.write(" "), 20);
        res.on("close", () => clearInterval(t));
        return true;
      };
    });
    afterAll(async () => {
      await stuck.close();
    });
    beforeEach(() => {
      stuck.requests = [];
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("runs one pass at a time", async () => {
      const { site, dc } = twoSites();
      saveLink(site.id, { baseUrl: stuck.url, unifiSite: "default", auth: { kind: "api_key", apiKey: stuck.apiKey }, certFingerprint: null, certPem: null });
      const first = syncDueLinks(1_000);
      await vi.waitFor(() => expect(stuck.requests).toHaveLength(1));
      // The mesh changes mid-pass: the next tick must not start a second pass alongside.
      addLan(dc.id, { cidr: "10.0.2.0/24", name: "More" });
      await syncDueLinks(1_000);
      await new Promise((r) => setTimeout(r, 100));
      expect(stuck.requests).toHaveLength(1);
      await first;
      expect(getLink(site.id)).toMatchObject({ lastSyncStatus: "error", lastSyncDetail: "the console took too long, so the sync was stopped" });
      // The change is picked up by the next pass once this one is over.
      await syncDueLinks(200);
      expect(stuck.requests).toHaveLength(2);
    });

    it("does not let a stuck console hold up the others", async () => {
      const { site, dc } = twoSites();
      saveLink(site.id, { baseUrl: stuck.url, unifiSite: "default", auth: { kind: "api_key", apiKey: stuck.apiKey }, certFingerprint: null, certPem: null });
      saveLink(dc.id, { baseUrl: fake.url, unifiSite: "default", auth: { kind: "api_key", apiKey: fake.apiKey }, certFingerprint: null, certPem: null });
      const started = Date.now();
      await syncDueLinks(300);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(getLink(site.id)!.lastSyncStatus).toBe("error");
      expect(getLink(dc.id)!.lastSyncStatus).not.toMatch(/error|never/);
      expect(fake.requests.length).toBeGreaterThan(0);
    });
  });
});
