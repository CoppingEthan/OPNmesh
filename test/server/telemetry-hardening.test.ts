/**
 * What one gateway token can make the controller store and show: only its
 * own peers and counters, at the rate it was asked for, with handshakes that
 * are not from the future and error events that cannot flood the log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { adminHeaders, bearer, gatewayOf, meshSite, req, type TestSite } from "./route-helpers";
import { getDb } from "@/db";
import { clients, events, pair5s, telemetry5s } from "@/db/schema";
import { generateKeyPair } from "@/core/crypto";
import { createClient, getClient, recordClientHandshake } from "@/server/clients";
import { controllerChecks } from "@/server/diagnostics";
import { liveState, telemetrySchema, type TelemetryReport } from "@/server/live";
import { getGenerated } from "@/server/snapshot";
import { createEnrolToken, createSite, addLan, enrolGateway, getSite, updateGateway } from "@/server/sites";
import { buildState } from "@/server/state";
import { clientViews, pairRateViews } from "@/server/status";
import { APPLY_ERROR_LOG_GAP_MS, ingestTelemetry, pairSeries } from "@/server/telemetry";
import { clientCounterNames, pairCounterName } from "@/core/generate/nftables";
import { POST as telemetryPost } from "../../app/api/agent/telemetry/route";
import { GET as stateGet } from "../../app/api/admin/state/route";
import { GET as trafficGet } from "../../app/api/admin/traffic/route";

let now = 1_800_000_000_000;
const sec = () => Math.floor(now / 1000);

beforeEach(() => {
  freshDb();
  liveState().resetFastModeForTests();
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  liveState().resetFastModeForTests();
  vi.restoreAllMocks();
});

type Peer = TelemetryReport["peers"][number];
const peer = (publicKey: string, bytes: number, latestHandshake = sec() - 5): Peer => ({ publicKey, endpoint: null, latestHandshake, rxBytes: bytes, txBytes: bytes, rttMs: 3 });
const report = (r: Partial<TelemetryReport>): TelemetryReport => telemetrySchema.parse({ version: "2.1.0", interfaceUp: true, ...r });
const junkKey = (i: number) => `${String(i).padStart(4, "0")}${"A".repeat(39)}=`;

/** Three sites that all accept connections, so every pair peers directly and none relays. */
function threeSites() {
  const alpha = meshSite("Alpha", "10.1.0.0/24", "10.1.0.2", "alpha.example.com", 1);
  const bravo = meshSite("Bravo", "10.2.0.0/24", "10.2.0.2", "bravo.example.com", 2);
  const charlie = meshSite("Charlie", "10.3.0.0/24", "10.3.0.2", "charlie.example.com", 3);
  const client = createClient({ name: "Laptop" });
  return { alpha, bravo, charlie, client };
}

const ingest = (t: TestSite, r: Partial<TelemetryReport>) => ingestTelemetry(gatewayOf(t), report(r));

describe("what a report may contain", () => {
  it("keeps only the gateway's own peers and counters, once each", () => {
    const { alpha, bravo, charlie, client } = threeSites();
    const send = (bytes: number) =>
      ingest(alpha, {
        peers: [peer(bravo.publicKey, bytes), peer(bravo.publicKey, 9e12), peer(charlie.publicKey, bytes), peer(client.publicKey, bytes), ...Array.from({ length: 500 }, (_, i) => peer(junkKey(i), bytes))],
        counters: [
          { name: "c5_alpha_to_bravo", bytes, packets: 1 },
          { name: "c5_alpha_to_bravo", bytes: 9e12, packets: 1 },
          { name: "c5_bravo_to_charlie", bytes, packets: 1 }, // alpha does not relay that pair
          ...Array.from({ length: 1000 }, (_, i) => ({ name: `c_junk${i}_to_x`, bytes, packets: 1 })),
        ],
      });
    send(1000);
    now += 5000;
    send(6000);

    const live = liveState().get(gatewayOf(alpha).id)!;
    expect(live.report.peers.map((p) => p.publicKey).sort()).toEqual([bravo.publicKey, charlie.publicKey, client.publicKey].sort());
    expect(live.report.counters.map((c) => c.name)).toEqual(["c5_alpha_to_bravo"]);
    expect(live.peerRates.get(bravo.publicKey)).toEqual({ rxBps: 1000, txBps: 1000 }); // the first copy, not the duplicate
    expect(getDb().select().from(telemetry5s).all()).toHaveLength(3);
    expect(getDb().select().from(pair5s).all().map((r) => `${r.fromSlug}>${r.toSlug}`)).toEqual(["alpha>bravo"]);
  });

  it("lets no gateway speak for another site's traffic, live or in history", () => {
    const { alpha, bravo, charlie } = threeSites();
    for (const bytes of [0, 5_000_000]) {
      ingest(alpha, { peers: [peer(bravo.publicKey, bytes)], counters: [{ name: "c5_alpha_to_bravo", bytes: bytes / 1000, packets: 1 }] });
      // Charlie is not on the path between alpha and bravo, yet claims a huge flow.
      ingest(charlie, { peers: [peer(alpha.publicKey, bytes)], counters: [{ name: "c5_alpha_to_bravo", bytes: bytes * 100, packets: 1 }] });
      now += 5000;
    }
    const gen = getGenerated();
    const pair = pairRateViews(gen.snapshot, liveState()).find((p) => p.fromSiteId === alpha.site.id && p.toSiteId === bravo.site.id)!;
    expect(pair.bps).toBe(1000); // alpha's own figure
    const rows = getDb().select().from(pair5s).all();
    expect(rows.map((r) => r.gatewayId)).toEqual([gatewayOf(alpha).id]);
    expect(pairSeries("alpha", "bravo", "1h", now).map((p) => p.bps)).toEqual([1000]);
  });
});

describe("what a gateway says in words", () => {
  it("is cleaned before it is kept or shown", () => {
    const { alpha, bravo, client } = threeSites();
    ingest(alpha, {
      version: "2.1.0\u202e\n\u0000x",
      host: { load1: null, memUsedPct: null, addresses: [], kernel: "6.8\r\nFORGED" },
      peers: [peer(bravo.publicKey, 1), peer(client.publicKey, 1)],
    });
    const live = liveState().get(gatewayOf(alpha).id)!.report;
    expect(live.version).toBe("2.1.0 x");
    expect(gatewayOf(alpha).agentVersion).toBe("2.1.0 x");
    expect(live.host.kernel).toBe("6.8 FORGED");
  });

  it("keeps a peer endpoint only when it is an address and a port", () => {
    const { alpha, bravo, charlie, client } = threeSites();
    const endpoints: Array<[string | null, string | null]> = [
      ["203.0.113.5:51820", "203.0.113.5:51820"],
      ["[2001:db8::1]:51820", "[2001:db8::1]:51820"],
      ["[fe80::1%eth0]:51820", "[fe80::1%eth0]:51820"],
      ["bravo.example.com:51820", null],
      ["203.0.113.5", null],
      ["203.0.113.5:0", null],
      ["203.0.113.5:65536", null],
      ["999.0.113.5:51820", null],
      ["2001:db8::1:51820", null],
      ["[2001:db8::zz]:51820", null],
      ["203.0.113.5:51820\u202e", null],
      [null, null],
    ];
    const peers = [bravo.publicKey, charlie.publicKey, client.publicKey];
    for (let i = 0; i < endpoints.length; i += peers.length) {
      const batch = endpoints.slice(i, i + peers.length);
      now += 5000;
      ingest(alpha, { peers: batch.map(([ep], j) => ({ ...peer(peers[j]!, 1), endpoint: ep })) });
      const got = liveState().get(gatewayOf(alpha).id)!.report.peers;
      batch.forEach(([ep, want], j) => expect(got.find((p) => p.publicKey === peers[j])!.endpoint, String(ep)).toBe(want));
    }
  });

  it("refuses configuration hashes that are not SHA-256 hex", () => {
    const hash = "ab".repeat(32);
    expect(telemetrySchema.safeParse({ appliedHash: hash, diskHash: hash }).success).toBe(true);
    expect(telemetrySchema.safeParse({ appliedHash: "", diskHash: "" }).success).toBe(true);
    for (const bad of ["h", "AB".repeat(32), "ab".repeat(31), `${"ab".repeat(31)}a\n`, `${"ab".repeat(31)}zz`, "<b>".repeat(21)]) {
      expect(telemetrySchema.safeParse({ appliedHash: bad }).success, bad).toBe(false);
      expect(telemetrySchema.safeParse({ diskHash: bad }).success, bad).toBe(false);
    }
  });
});

describe("the telemetry route", () => {
  const post = (token: string, body: string) =>
    telemetryPost(new Request("http://controller.test/api/agent/telemetry", { method: "POST", headers: { host: "controller.test", ...bearer(token) }, body }));

  it("reads a report only when it will be kept", async () => {
    const { alpha } = threeSites();
    // Bad bodies: the burst an agent may send at start is read (and refused),
    // the rest come too soon to be kept, so they are answered without being read.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await post(alpha.token, "{not json")).status);
    expect(statuses).toEqual([400, 400, 400, 200, 200, 200, 200, 200, 200, 200]);
    const answer = await (await post(alpha.token, "{not json")).json();
    expect(answer).toMatchObject({ status: "active", configHash: getGenerated().bundle.gateways[gatewayOf(alpha).id]!.hash, intervalSeconds: 5 });
    // Once one is due again it is read.
    now += 2500;
    expect((await post(alpha.token, "{not json")).status).toBe(400);
    now += 2500;
    expect((await post(alpha.token, JSON.stringify({ version: "2.1.9" }))).status).toBe(200);
    expect(liveState().get(gatewayOf(alpha).id)!.report.version).toBe("2.1.9");
  });

  it("does not read a report from a gateway that is not active", async () => {
    const s = createSite({ name: "Branch" });
    addLan(s.id, { cidr: "10.9.0.0/24", name: "LAN" });
    const r = enrolGateway({ token: createEnrolToken(s.id, { autoApprove: false }).token, publicKey: generateKeyPair().publicKey, hostname: "b", os: "", arch: "", addresses: ["10.9.0.2"], agentVersion: "" });
    if (!r.ok) throw new Error(r.reason);
    const res = await post(r.gatewayToken, "{not json");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "pending", configHash: "" });
  });

  it("refuses a body far larger than any report", async () => {
    const { alpha } = threeSites();
    const res = await post(alpha.token, JSON.stringify({ version: "2.1.0", padding: "x".repeat(600 * 1024) }));
    expect(res.status).toBe(413);
    // A report the size a large mesh sends is fine.
    now += 5000;
    const big = report({ peers: Array.from({ length: 800 }, (_, i) => peer(junkKey(i), 1e12)), counters: Array.from({ length: 2000 }, (_, i) => ({ name: `c11_branch_${String(i).padStart(4, "0")}_to_office`, bytes: 1e12, packets: 1e9 })) });
    const body = JSON.stringify(big);
    expect(body.length).toBeGreaterThan(256 * 1024);
    expect((await post(alpha.token, body)).status).toBe(200);
  });
});

describe("traffic history", () => {
  it("is found for sites whose slug has a hyphen", async () => {
    const { alpha } = threeSites();
    const branch = meshSite("Branch Office", "10.4.0.0/24", "10.4.0.2", "branch.example.com", 4);
    expect(branch.site.slug).toBe("branch-office");
    const name = pairCounterName(branch.site, alpha.site);
    const fromClients = clientCounterNames(branch.site).toSite;
    for (const bytes of [0, 5000]) {
      ingest(branch, { counters: [{ name, bytes, packets: 1 }, { name: fromClients, bytes, packets: 1 }] });
      now += 5000;
    }
    expect(liveState().get(gatewayOf(branch).id)!.counterRates.get(fromClients)).toBe(1000);
    expect(pairSeries("branch-office", "alpha", "1h", now).map((p) => p.bps)).toEqual([1000]);
    const res = await trafficGet(req("GET", "/api/admin/traffic?range=1h&from=branch-office&to=alpha", undefined, adminHeaders()));
    expect((await res.json()).points.map((p: { bps: number }) => p.bps)).toEqual([1000]);
    // The clients' counters are live figures only and never mix with a site's history.
    expect(getDb().select().from(pair5s).all().map((r) => `${r.fromSlug}>${r.toSlug}`)).toEqual(["branch_office>alpha"]);
  });
});

describe("handshake times", () => {
  it("ignores handshakes from the future, so a false one cannot pin a client online", () => {
    const { alpha, charlie, client } = threeSites();
    const century = sec() + 100 * 365 * 24 * 3600;
    ingest(charlie, { peers: [peer(client.publicKey, 0, century)] });
    const gen = getGenerated();
    const row = () => getClient(client.id)!;
    expect(liveState().get(gatewayOf(charlie).id)!.report.peers[0]!.latestHandshake).toBe(0);
    expect(row().lastHandshakeAt).toBeNull();
    expect(clientViews([row()], gen.snapshot, liveState(), now)[0]!.online).toBe(false);

    // A small clock skew is believed; a real handshake later is still recorded.
    ingest(alpha, { peers: [peer(client.publicKey, 0, sec() + 60)] });
    expect(row().lastHandshakeAt).toBe((sec() + 60) * 1000);
    now += 10 * 60_000;
    ingest(alpha, { peers: [peer(client.publicKey, 0, sec() - 2)] });
    expect(row().lastHandshakeAt).toBe((sec() - 2) * 1000);
    expect(clientViews([row()], gen.snapshot, liveState(), now)[0]!.online).toBe(true);
  });

  it("disregards a future value already in the database, and replaces it", () => {
    const { client } = threeSites();
    getDb().update(clients).set({ lastHandshakeAt: now + 100 * 365 * 24 * 3_600_000 }).run();
    const gen = getGenerated();
    const view = clientViews([getClient(client.id)!], gen.snapshot, liveState(), now)[0]!;
    expect(view.online).toBe(false);
    expect(view.lastHandshakeAt).toBeNull();
    recordClientHandshake(client.publicKey, now - 30_000);
    expect(getClient(client.id)!.lastHandshakeAt).toBe(now - 30_000);
  });
});

describe("minimum report interval", () => {
  it("answers reports that come too soon as usual but does not store them", async () => {
    const { alpha, bravo } = threeSites();
    const post = (version: string, bytes: number) => telemetryPost(req("POST", "/api/agent/telemetry", report({ version, peers: [peer(bravo.publicKey, bytes)] }), bearer(alpha.token)));
    const answers = [];
    for (let i = 1; i <= 10; i++) answers.push(await (await post(`2.1.${i}`, i * 1000)).json());
    // All ten get the same, complete answer: the agent carries on as normal.
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toMatchObject({ status: "active", configHash: getGenerated().bundle.gateways[gatewayOf(alpha).id]!.hash, intervalSeconds: 5, actions: [] });
    // A restarting agent's burst is kept; the rest is not.
    const live = () => liveState().get(gatewayOf(alpha).id)!;
    expect(live().report.version).toBe("2.1.3");
    expect(gatewayOf(alpha).agentVersion).toBe("2.1.3");

    // Half an interval (2.5 s) later one more report is due.
    now += 2000;
    await post("2.1.11", 11_000);
    expect(live().report.version).toBe("2.1.3");
    now += 600;
    await post("2.1.12", 12_000);
    expect(live().report.version).toBe("2.1.12");
  });

  it("bounds what a flood can store, while a well-behaved agent loses nothing", () => {
    const { alpha, bravo } = threeSites();
    const gw = gatewayOf(alpha);
    const kept = () => getDb().select().from(telemetry5s).all().length;
    // Two reports a second for a minute, each far enough apart to yield a rate if kept.
    for (let i = 0; i < 120; i++) {
      ingestTelemetry(gw, report({ peers: [peer(bravo.publicKey, i)] }));
      now += 500;
    }
    expect(kept()).toBeGreaterThan(0);
    expect(kept()).toBeLessThanOrEqual(3 + 60 / 2.5);
    // The agent's own cadence: the interval plus up to a fifth of jitter.
    const before = kept();
    for (let i = 0; i < 100; i++) {
      now += 5000 + ((i * 37) % 1000);
      ingestTelemetry(gw, report({ peers: [peer(bravo.publicKey, 1e6 + i)] }));
    }
    expect(kept() - before).toBe(100);
  });

  it("keeps accepting reports after the controller's clock steps back", () => {
    const { alpha } = threeSites();
    const gw = gatewayOf(alpha);
    const stored = (version: string) => {
      ingestTelemetry(gw, report({ version }));
      return liveState().get(gw.id)!.report.version === version;
    };
    expect(stored("a")).toBe(true);
    now -= 3_600_000;
    expect(stored("b")).toBe(true);
    for (let i = 0; i < 5; i++) {
      now += 5000;
      expect(stored(`c${i}`)).toBe(true);
    }
  });
});

describe("audit log from apply errors", () => {
  const applyErrors = () => getDb().select().from(events).all().filter((e) => e.kind === "apply-error");

  it("logs an error when it appears or changes, at most once per few minutes", () => {
    const { alpha } = threeSites();
    // Alternating errors every report for ten minutes.
    for (let i = 0; i < 120; i++) {
      ingestTelemetry(gatewayOf(alpha), report({ lastError: i % 2 ? "nft: syntax error" : "wg: bad key" }));
      now += 5000;
    }
    expect(applyErrors().map((e) => e.ts)).toEqual([1_800_000_000_000, 1_800_000_000_000 + APPLY_ERROR_LOG_GAP_MS]);
    // The gateway row always has the latest.
    expect(gatewayOf(alpha).lastError).toBe("nft: syntax error");
    // The same error repeated is not news, however long it lasts.
    for (let i = 0; i < 120; i++) {
      ingestTelemetry(gatewayOf(alpha), report({ lastError: "nft: syntax error" }));
      now += 5000;
    }
    expect(applyErrors()).toHaveLength(2);
  });

  it("strips control characters and caps the length", () => {
    const { alpha } = threeSites();
    ingestTelemetry(gatewayOf(alpha), report({ lastError: `line one\nFORGED LINE\r\u001b[31mred\u202eevil\u0000 ${"x".repeat(1900)}` }));
    const stored = gatewayOf(alpha).lastError;
    expect(stored.startsWith("line one FORGED LINE [31mred evil ")).toBe(true);
    expect(stored).toHaveLength(500);
    const [e] = applyErrors();
    expect(e!.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(e!.message.length).toBeLessThan(400);
  });
});

describe("live data that no longer describes the present", () => {
  it("is forgotten when a gateway is replaced or disabled", () => {
    const { alpha, bravo } = threeSites();
    ingest(alpha, {});
    ingest(bravo, {});
    const oldAlpha = gatewayOf(alpha).id;
    const { token } = createEnrolToken(alpha.site.id);
    const r = enrolGateway({ token, publicKey: generateKeyPair().publicKey, hostname: "rebuilt", os: "", arch: "", addresses: ["10.1.0.9"], agentVersion: "2.1.0" });
    expect(r.ok).toBe(true);
    expect(liveState().get(oldAlpha)).toBeUndefined();
    const bravoId = gatewayOf(bravo).id;
    expect(liveState().get(bravoId)).toBeDefined();
    updateGateway(bravo.site.id, { status: "disabled" });
    expect(liveState().get(bravoId)).toBeUndefined();
  });

  it("is left out of rates and handshakes once older than three intervals", async () => {
    const { alpha, bravo, client } = threeSites();
    const start = now;
    for (const bytes of [0, 50_000]) {
      ingest(alpha, { peers: [peer(bravo.publicKey, bytes), peer(client.publicKey, bytes)], counters: [{ name: "c5_alpha_to_bravo", bytes, packets: 1 }] });
      ingest(bravo, { peers: [peer(alpha.publicKey, bytes)], counters: [{ name: "c5_alpha_to_bravo", bytes, packets: 1 }] });
      now += 5000;
    }
    const at = start + 5000;
    const fresh = buildState(at + 15_000);
    expect(fresh.pairs.find((p) => p.fromSiteId === alpha.site.id && p.toSiteId === bravo.site.id)!.bps).toBe(10_000);
    expect(fresh.siteRates.find((r) => r.siteId === alpha.site.id)!.inBps).toBe(20_000);
    expect(fresh.tunnels[0]!.aToB).toBe(10_000);
    expect(fresh.clients[0]!.rxBps).toBe(10_000);

    // (The dashboard payload is cached for up to a second, so look a second later.)
    const stale = buildState(at + 16_000);
    expect(stale.pairs.every((p) => p.bps === 0)).toBe(true);
    expect(stale.siteRates.every((r) => r.inBps === 0 && r.outBps === 0)).toBe(true);
    expect(stale.tunnels.every((t) => t.aToB === 0 && t.bToA === 0 && t.health === "unknown")).toBe(true);
    expect(stale.clients[0]!.rxBps).toBe(0);
    // The gateway itself is still listed, just no longer online.
    expect(stale.sites.find((s) => s.id === alpha.site.id)!.gateway!.health).toBe("stale");

    // The admin API serves the same filtered view.
    now = at + 17_000;
    const body = await (await stateGet(req("GET", "/api/admin/state", undefined, adminHeaders()))).json();
    expect(body.pairs.every((p: { bps: number }) => p.bps === 0)).toBe(true);
  });
});

describe("inbound health check", () => {
  it("counts only current reports from the gateways that must dial in", async () => {
    // dc accepts connections; shop dials out; office accepts connections too.
    const dc = meshSite("DC", "10.0.1.0/24", "10.0.250.2", "dc.example.com", 1);
    const shop = meshSite("Shop", "10.40.0.0/24", "10.40.0.2", null, 2);
    const office = meshSite("Office", "192.168.20.0/24", "192.168.20.2", "203.0.113.5", 3);
    const inbound = async () => (await controllerChecks(dc.site.id)).find((c) => c.id === "inbound")!;
    ingest(dc, { peers: [peer(shop.publicKey, 0, 0), peer(office.publicKey, 0)] });
    ingest(shop, { peers: [peer(dc.publicKey, 0, 0), peer(office.publicKey, 0)] });
    // Office handshaking with dc proves nothing about dc's port forward to shop, and is not counted as a dialer.
    ingest(office, { peers: [peer(dc.publicKey, 0), peer(shop.publicKey, 0)] });
    expect((await inbound()).status).toBe("fail");
    expect((await inbound()).detail).toContain("Shop");
    expect((await inbound()).detail).not.toContain("Office");

    // Twenty seconds on, only dc has reported again: shop's old claim no longer counts.
    now += 20_000;
    ingest(dc, { peers: [peer(shop.publicKey, 0, 0), peer(office.publicKey, 0)] });
    expect((await inbound()).status).toBe("skip");
  });
});

describe("sites outside the mesh", () => {
  it("contribute nothing even if a report was once stored for them", () => {
    const s = createSite({ name: "Branch" });
    addLan(s.id, { cidr: "10.9.0.0/24", name: "LAN" });
    const { token } = createEnrolToken(s.id, { autoApprove: false });
    const r = enrolGateway({ token, publicKey: generateKeyPair().publicKey, hostname: "b", os: "", arch: "", addresses: ["10.9.0.2"], agentVersion: "" });
    if (!r.ok) throw new Error(r.reason);
    // A pending gateway's report never reaches ingest; nothing can be claimed for it.
    const gw = getSite(s.id)!.gateway!;
    ingestTelemetry(gw, report({ peers: [peer(generateKeyPair().publicKey, 5)], counters: [{ name: "c_branch_to_x", bytes: 1, packets: 1 }] }));
    expect(liveState().get(gw.id)!.report.peers).toEqual([]);
    expect(liveState().get(gw.id)!.report.counters).toEqual([]);
  });
});
