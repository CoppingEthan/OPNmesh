import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { addLan, createEnrolToken, createSite, enrolGateway, getSite, updateGateway } from "@/server/sites";
import { createClient, getClient } from "@/server/clients";
import { ADDRESS_LOG_GAP_MS, ingestTelemetry, pairSeries, peerSeries, runRollups, siteSeries } from "@/server/telemetry";
import { liveState, telemetrySchema, type TelemetryReport } from "@/server/live";
import { liveSeries } from "@/server/live-series";
import { getGenerated } from "@/server/snapshot";
import { clientViews, gatewayView, pairRateViews, tunnelViews } from "@/server/status";
import { getDb } from "@/db";
import { events, telemetry1m, telemetry5s } from "@/db/schema";
import { generateKeyPair } from "@/core/crypto";

let now = 1_800_000_000_000;
const tick = (ms: number) => (now += ms);

function setup() {
  const dc = createSite({ name: "DC", hubPriority: 1 });
  addLan(dc.id, { cidr: "10.0.1.0/24", name: "Servers" });
  const office = createSite({ name: "Office", hubPriority: 2 });
  addLan(office.id, { cidr: "192.168.20.0/24", name: "Staff" });
  for (const [s, addr, ep] of [
    [dc, "10.0.250.2", "dc.example.com"],
    [office, "192.168.250.2", "203.0.113.20"],
  ] as const) {
    const { token } = createEnrolToken(s.id);
    const r = enrolGateway({ token, publicKey: generateKeyPair().publicKey, hostname: s.slug, os: "ubuntu", arch: "amd64", addresses: [addr], agentVersion: "2.0.0" });
    if (!r.ok) throw new Error(r.reason);
    updateGateway(s.id, { endpointHost: ep });
  }
  const client = createClient({ name: "Laptop" });
  return { dc: getSite(dc.id)!, office: getSite(office.id)!, client: getClient(client.id)! };
}

/** Some configuration other than the one generated. */
const OTHER_HASH = "0".repeat(64);

function report(partial: Partial<TelemetryReport> & { peers: TelemetryReport["peers"] }): TelemetryReport {
  return telemetrySchema.parse({ version: "2.0.0", appliedHash: OTHER_HASH, diskHash: OTHER_HASH, ...partial });
}

beforeEach(() => {
  freshDb();
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingest", () => {
  it("derives rates from successive reports and stores 5 s samples", () => {
    const { dc, office } = setup();
    const gen = getGenerated();
    const gwDc = dc.gateway!;
    const officeKey = office.gateway!.publicKey;
    const first = ingestTelemetry(gwDc, report({ peers: [{ publicKey: officeKey, endpoint: "203.0.113.20:51820", latestHandshake: Math.floor(now / 1000), rxBytes: 1000, txBytes: 2000, rttMs: 12 }], counters: [{ name: "c2_dc_to_office", bytes: 500, packets: 5 }] }));
    expect(first.configHash).toBe(gen.bundle.gateways[gwDc.id]!.hash);
    expect(first.intervalSeconds).toBe(5);
    expect(getDb().select().from(telemetry5s).all()).toHaveLength(0); // no rate yet

    liveState(); // same instance
    // 5 s later: 5000 more bytes received, 10000 sent.
    const at = tick(5000);
    ingestTelemetry(gwDc, report({ peers: [{ publicKey: officeKey, endpoint: "203.0.113.20:51820", latestHandshake: Math.floor(now / 1000), rxBytes: 6000, txBytes: 12000, rttMs: 14 }], counters: [{ name: "c2_dc_to_office", bytes: 5500, packets: 50 }] }));
    const live = liveState().get(gwDc.id)!;
    expect(live.peerRates.get(officeKey)).toEqual({ rxBps: 1000, txBps: 2000 });
    expect(live.counterRates.get("c2_dc_to_office")).toBe(1000);
    const rows = getDb().select().from(telemetry5s).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rxBps).toBe(1000);
    expect(rows[0]!.rttMs).toBe(14);

    const tunnels = tunnelViews(gen.snapshot, liveState(), at);
    expect(tunnels).toHaveLength(1);
    expect(tunnels[0]!.health).toBe("up");
    expect(tunnels[0]!.aToB).toBe(2000); // dc → office = dc's tx
    expect(tunnels[0]!.bToA).toBe(1000);
    expect(tunnels[0]!.rttMs).toBe(14);
    const pairs = pairRateViews(gen.snapshot, liveState());
    expect(pairs.find((p) => p.fromSiteId === dc.id && p.toSiteId === office.id)!.bps).toBe(1000);
    expect(pairs.find((p) => p.fromSiteId === office.id && p.toSiteId === dc.id)!.bps).toBe(0);

    const view = gatewayView(getSite(dc.id)!.gateway!, "dc", live, first.configHash, at, 5);
    expect(view.health).toBe("online");
    expect(view.attention).toBe("configuration change not yet applied"); // reported hash ≠ desired
  });

  it("marks gateways stale and offline as reports age", () => {
    const { dc } = setup();
    const gw = dc.gateway!;
    ingestTelemetry(gw, report({ peers: [] }));
    const live = liveState().get(gw.id);
    expect(gatewayView(gw, "dc", live, "", now, 5).health).toBe("online");
    expect(gatewayView(gw, "dc", live, "", now + 30_000, 5).health).toBe("stale");
    expect(gatewayView(gw, "dc", live, "", now + 120_000, 5).health).toBe("offline");
    expect(gatewayView({ ...gw, status: "pending" }, "dc", undefined, "", now, 5).health).toBe("pending");
  });

  it("tracks client presence from handshakes", () => {
    const { dc, client } = setup();
    const gw = dc.gateway!;
    const gen = getGenerated();
    ingestTelemetry(gw, report({ peers: [{ publicKey: client.publicKey, endpoint: "198.51.100.7:41000", latestHandshake: Math.floor(now / 1000) - 20, rxBytes: 10, txBytes: 10, rttMs: null }] }));
    const views = clientViews([getClient(client.id)!], gen.snapshot, liveState(), now);
    expect(views[0]!.online).toBe(true);
    expect(views[0]!.viaSiteId).toBe(dc.id);
    expect(views[0]!.endpoint).toBe("198.51.100.7:41000");
    expect(getClient(client.id)!.lastHandshakeAt).toBe((Math.floor(now / 1000) - 20) * 1000);
  });

  it("rejects malformed reports", () => {
    expect(telemetrySchema.safeParse({ peers: [{ publicKey: "short", rxBytes: 1, txBytes: 1 }] }).success).toBe(false);
    expect(telemetrySchema.safeParse({ peers: [{ publicKey: "x".repeat(44), rxBytes: -1, txBytes: 1 }] }).success).toBe(false);
    expect(telemetrySchema.safeParse({}).success).toBe(true);
  });
});

describe("gateway addresses", () => {
  const gw = (siteId: string) => getSite(siteId)!.gateway!;
  /** A report as the agent sends it: every interface's address with its prefix length. */
  const hostReport = (addresses?: string[]) => telemetrySchema.parse({ version: "2.0.0", ...(addresses ? { host: { addresses } } : {}) });
  /** How many updates have written the column; SQLite fires the trigger even when the value is unchanged. */
  const countWrites = () => {
    getDb().$client.exec("CREATE TABLE address_writes (n INTEGER); CREATE TRIGGER count_address_writes AFTER UPDATE OF addresses ON gateways BEGIN INSERT INTO address_writes VALUES (1); END;");
    return () => (getDb().$client.prepare("SELECT COUNT(*) AS n FROM address_writes").get() as { n: number }).n;
  };
  const addressEvents = () => getDb().select().from(events).all().filter((e) => e.kind === "gateway" && e.message.includes(" now holds "));

  it("follow a re-addressed gateway, written only when they change", () => {
    const { dc } = setup();
    const { tunnelIp } = gw(dc.id);
    const writes = countWrites();
    const send = (addresses?: string[]) => {
      ingestTelemetry(gw(dc.id), hostReport(addresses));
      tick(5000);
    };

    // What it enrolled with, as the agent reports it once WireGuard is up: the tunnel address is shown on its own.
    send(["10.0.250.2/29", `${tunnelIp}/24`]);
    expect(gw(dc.id).addresses).toEqual(["10.0.250.2"]);
    expect(writes()).toBe(0);

    // Moved onto another network: filtered as enrolment filters.
    send(["10.20.0.5/24", "127.0.0.1/8", "169.254.3.4/16", `${tunnelIp}/24`]);
    expect(gw(dc.id).addresses).toEqual(["10.20.0.5"]);
    expect(writes()).toBe(1);
    for (let i = 0; i < 10; i++) send(["10.20.0.5/24", `${tunnelIp}/24`]);
    expect(writes()).toBe(1);

    // A report with nothing usable, or no host facts at all, does not wipe the list.
    send([]);
    send(["127.0.0.1/8", `${tunnelIp}/24`]);
    send();
    expect(gw(dc.id).addresses).toEqual(["10.20.0.5"]);
    expect(writes()).toBe(1);

    const many = Array.from({ length: 20 }, (_, i) => `10.20.${i}.5/24`);
    send(many);
    expect(gw(dc.id).addresses).toEqual(many.slice(0, 16).map((a) => a.split("/")[0]));
  });

  it("log a change to the audit log, at most once per few minutes", () => {
    const { dc } = setup();
    ingestTelemetry(gw(dc.id), hostReport(["10.20.0.5/24"]));
    expect(addressEvents().map((e) => [e.message, e.actor, e.subject])).toEqual([['Gateway "DC gateway" now holds 10.20.0.5 (was 10.0.250.2)', "gateway", dc.id]]);
    expect(JSON.parse(addressEvents()[0]!.detail!)).toEqual({ before: ["10.0.250.2"], after: ["10.20.0.5"] });
    // A gateway whose addresses flap on every report for ten minutes.
    for (let i = 1; i < 120; i++) {
      tick(5000);
      ingestTelemetry(gw(dc.id), hostReport([i % 2 ? "10.20.0.6/24" : "10.20.0.5/24"]));
    }
    expect(addressEvents().map((e) => e.ts)).toEqual([1_800_000_000_000, 1_800_000_000_000 + ADDRESS_LOG_GAP_MS]);
    // The gateway row always has the latest.
    expect(gw(dc.id).addresses).toEqual(["10.20.0.6"]);
  });
});

describe("site series and live series", () => {
  it("sums every peer of a gateway and buckets long ranges", () => {
    const db = getDb();
    const base = Math.floor(now / 3_600_000) * 3_600_000;
    const ins = db.$client.prepare("INSERT INTO telemetry_5s (ts, gateway_id, peer_key, rx_bytes, tx_bytes, rx_bps, tx_bps, handshake_age_s, rtt_ms) VALUES (?,?,?,?,?,?,?,?,?)");
    for (let i = 0; i < 12; i++) {
      ins.run(base + i * 5000, "gw1", "peerA", 0, 0, 100, 10, 0, null);
      ins.run(base + i * 5000, "gw1", "peerB", 0, 0, 50, 5, 0, null);
    }
    // An hour of 5 s samples would be 720 points; they are bucketed to 10 s (≤ 600 points).
    const pts = siteSeries("gw1", "1h", base + 60_000);
    expect(pts).toHaveLength(6);
    expect(pts[0]).toEqual({ ts: base, inBps: 150, outBps: 15 });
    // A year of hourly rows is reduced to ~600 buckets.
    const insH = db.$client.prepare("INSERT INTO telemetry_1h (ts, gateway_id, peer_key, rx_bps, tx_bps, rtt_ms) VALUES (?,?,?,?,?,?)");
    for (let h = 0; h < 24 * 30; h++) insH.run(base - h * 3_600_000, "gw1", "peerA", h % 2 ? 200 : 100, 1, null);
    const year = siteSeries("gw1", "1y", base + 60_000);
    expect(year.length).toBeGreaterThan(40);
    expect(year.length).toBeLessThan(80); // 720 hours in 15-hour buckets
    expect(year.every((p) => p.inBps >= 100 && p.inBps <= 200)).toBe(true);
  });

  it("samples per-site rates once a second into a bounded window", () => {
    const { dc, office } = setup();
    const gwDc = dc.gateway!;
    const officeKey = office.gateway!.publicKey;
    ingestTelemetry(gwDc, report({ peers: [{ publicKey: officeKey, endpoint: null, latestHandshake: 0, rxBytes: 0, txBytes: 0, rttMs: null }] }));
    tick(5000);
    ingestTelemetry(gwDc, report({ peers: [{ publicKey: officeKey, endpoint: null, latestHandshake: 0, rxBytes: 5000, txBytes: 10_000, rttMs: null }] }));
    const ls = liveSeries();
    ls.clearForTests();
    // The last sample is taken as the report arrives, so the report is current.
    for (let i = 0; i < 130; i++) ls.sample(now - (129 - i) * 1000);
    const p = ls.payload();
    expect(p.ts).toHaveLength(120);
    expect(p.sites[dc.id]!.in[119]).toBe(1000);
    expect(p.sites[dc.id]!.out[119]).toBe(2000);
    expect(p.sites[office.id]!.in[119]).toBe(0);
    // Three intervals later the report no longer describes the present.
    ls.sample(now + 15_000);
    expect(ls.payload().sites[dc.id]!.in[119]).toBe(1000);
    ls.sample(now + 15_001);
    expect(ls.payload().sites[dc.id]!.in[119]).toBe(0);
  });
});

describe("rollups", () => {
  it("averages 5 s samples into minutes and hours and prunes raw data", () => {
    const db = getDb();
    const base = Math.floor(now / 3_600_000) * 3_600_000; // start of an hour
    // Two peers, 12 samples a minute for 61 minutes.
    const ins = db.$client.prepare("INSERT INTO telemetry_5s (ts, gateway_id, peer_key, rx_bytes, tx_bytes, rx_bps, tx_bps, handshake_age_s, rtt_ms) VALUES (?,?,?,?,?,?,?,?,?)");
    const insPair = db.$client.prepare("INSERT INTO pair_5s (ts, gateway_id, from_slug, to_slug, bytes, bps) VALUES (?,?,?,?,?,?)");
    for (let m = 0; m < 61; m++) {
      for (let s = 0; s < 12; s++) {
        const ts = base + m * 60_000 + s * 5_000;
        ins.run(ts, "gw1", "peerA", 0, 0, 100 + s, 200, 10, 5);
        insPair.run(ts, "gw1", "dc", "office", 0, 50);
      }
    }
    const at = base + 61 * 60_000 + 30_000;
    const r = runRollups(at);
    expect(r.minutes).toBe(61);
    expect(r.hours).toBe(1);
    const mins = db.select().from(telemetry1m).all();
    expect(mins).toHaveLength(61);
    expect(mins[0]!.rxBps).toBeCloseTo(105.5, 5); // avg of 100..111
    expect(mins[0]!.txBps).toBe(200);
    const hours = db.$client.prepare("SELECT * FROM telemetry_1h").all() as Array<{ rx_bps: number }>;
    expect(hours).toHaveLength(1);
    expect(hours[0]!.rx_bps).toBeCloseTo(105.5, 5);
    expect(db.$client.prepare("SELECT COUNT(*) AS n FROM pair_1h").get()).toEqual({ n: 1 });
    // Raw retention is two hours, so nothing pruned yet; idempotent on rerun.
    expect(runRollups(at)).toEqual({ minutes: 0, hours: 0 });
    expect(db.select().from(telemetry5s).all().length).toBe(61 * 12);
    expect(peerSeries("gw1", "peerA", "24h", at).length).toBe(61);
    expect(peerSeries("gw1", "peerA", "1h", at).length).toBeGreaterThan(600);
    expect(pairSeries("dc", "office", "24h", at)[0]!.bps).toBe(50);
    // Three hours later the raw samples are gone.
    runRollups(at + 3 * 3_600_000);
    expect(db.select().from(telemetry5s).all().length).toBe(0);
  });
});
