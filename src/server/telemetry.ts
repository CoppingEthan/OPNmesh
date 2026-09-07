/**
 * Telemetry ingest and time-series storage.
 *
 * Every report updates live state (rates), the gateway row (last seen,
 * applied hash, errors) and, when rates were computable, appends 5-second
 * samples. A scheduled rollup averages 5 s → 1 min → 1 h and prunes.
 */
import { and, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { pair1h, pair1m, pair5s, telemetry1h, telemetry1m, telemetry5s } from "@/db/schema";
import type { GatewayRow } from "@/db/schema";
import { logEvent } from "./events";
import { liveState, type TelemetryReport } from "./live";
import { recordClientHandshake } from "./clients";
import { recordGatewayReport } from "./sites";
import { getGenerated } from "./snapshot";
import { getSettings } from "./settings";
import { now } from "./env";

export interface IngestOutcome {
  configHash: string;
  intervalSeconds: number;
}

export function ingestTelemetry(gw: GatewayRow, report: TelemetryReport): IngestOutcome {
  const t = now();
  const gen = getGenerated();
  const desired = gen.bundle.gateways[gw.id]?.hash ?? "";
  const { live, hasRates } = liveState().ingest(gw.id, gw.siteId, report, t);

  const prevError = gw.lastError;
  recordGatewayReport(gw.id, { agentVersion: report.version, appliedHash: report.appliedHash, diskHash: report.diskHash, lastError: report.lastError });
  if (report.lastError && report.lastError !== prevError) {
    logEvent("apply-error", `Gateway ${gw.name} failed to apply configuration: ${report.lastError.slice(0, 300)}`, { actor: "gateway", subject: gw.siteId });
  }

  const clientKeys = new Set(gen.snapshot.clients.map((c) => c.publicKey));
  for (const p of report.peers) {
    if (p.latestHandshake > 0 && clientKeys.has(p.publicKey)) recordClientHandshake(p.publicKey, p.latestHandshake * 1000);
  }

  if (hasRates) {
    const db = getDb();
    db.transaction((tx) => {
      for (const p of report.peers) {
        const r = live.peerRates.get(p.publicKey);
        if (!r) continue;
        tx.insert(telemetry5s)
          .values({
            ts: t,
            gatewayId: gw.id,
            peerKey: p.publicKey,
            rxBytes: p.rxBytes,
            txBytes: p.txBytes,
            rxBps: r.rxBps,
            txBps: r.txBps,
            handshakeAgeS: p.latestHandshake > 0 ? Math.max(0, Math.floor(t / 1000 - p.latestHandshake)) : null,
            rttMs: p.rttMs,
          })
          .onConflictDoNothing()
          .run();
      }
      for (const c of report.counters) {
        const bps = live.counterRates.get(c.name);
        if (bps === undefined) continue;
        const m = /^c_(.+)_to_(.+)$/.exec(c.name);
        if (!m) continue;
        tx.insert(pair5s)
          .values({ ts: t, gatewayId: gw.id, fromSlug: m[1]!, toSlug: m[2]!, bytes: c.bytes, bps })
          .onConflictDoNothing()
          .run();
      }
    });
  }

  // While someone is watching the overview, one report a second makes the
  // picture genuinely live; otherwise the configured interval keeps things quiet.
  return { configHash: desired, intervalSeconds: liveState().fastMode(t) ? 1 : getSettings().telemetryIntervalS };
}

// ---------------------------------------------------------------------------
// Rollups

export const RETENTION = {
  raw5s: 2 * 60 * 60 * 1000,
  min1: 30 * 24 * 60 * 60 * 1000,
  hour1: 2 * 365 * 24 * 60 * 60 * 1000,
};

const MIN = 60_000;
const HOUR = 3_600_000;

/**
 * Roll the last complete minute(s) of 5 s samples into 1 m rows and the last
 * complete hour(s) of 1 m rows into 1 h rows, then prune. Idempotent: rows
 * already present are left alone (INSERT OR IGNORE), so running it late or
 * twice is harmless.
 */
const g = globalThis as unknown as { __opnmeshRollup?: { minute: number; hour: number } };

/** Tests: forget where the previous pass stopped. */
export function resetRollupWatermarkForTests(): void {
  g.__opnmeshRollup = undefined;
}

export function runRollups(at = now()): { minutes: number; hours: number } {
  const db = getDb();
  const s = db.$client;
  const minuteEnd = Math.floor(at / MIN) * MIN;
  const hourEnd = Math.floor(at / HOUR) * HOUR;
  let minutes = 0;
  let hours = 0;
  // Where the previous pass stopped. Samples are stamped with the time they
  // arrive, so a completed minute or hour never gains rows later and can be
  // left alone; without this every pass would rescan a month of minute rows.
  // The first pass after a start (or a clock that went backwards) starts
  // from the oldest sample present instead.
  const wm = g.__opnmeshRollup;

  s.transaction(() => {
    let fromMinute = wm && wm.minute <= minuteEnd ? wm.minute : null;
    if (fromMinute === null) {
      const oldestRaw = s.prepare("SELECT MIN(ts) AS t FROM telemetry_5s").get() as { t: number | null };
      fromMinute = oldestRaw.t === null ? null : Math.floor(oldestRaw.t / MIN) * MIN;
    }
    if (fromMinute !== null) {
      for (let m = fromMinute; m < minuteEnd; m += MIN) {
        const r = s
          .prepare(
            `INSERT OR IGNORE INTO telemetry_1m (ts, gateway_id, peer_key, rx_bps, tx_bps, rtt_ms)
             SELECT ?, gateway_id, peer_key, AVG(rx_bps), AVG(tx_bps), AVG(rtt_ms)
             FROM telemetry_5s WHERE ts >= ? AND ts < ? GROUP BY gateway_id, peer_key`,
          )
          .run(m, m, m + MIN);
        minutes += r.changes;
        s.prepare(
          `INSERT OR IGNORE INTO pair_1m (ts, gateway_id, from_slug, to_slug, bps)
           SELECT ?, gateway_id, from_slug, to_slug, AVG(bps)
           FROM pair_5s WHERE ts >= ? AND ts < ? GROUP BY gateway_id, from_slug, to_slug`,
        ).run(m, m, m + MIN);
      }
    }
    let fromHour = wm && wm.hour <= hourEnd ? wm.hour : null;
    if (fromHour === null) {
      const oldestMin = s.prepare("SELECT MIN(ts) AS t FROM telemetry_1m").get() as { t: number | null };
      fromHour = oldestMin.t === null ? null : Math.floor(oldestMin.t / HOUR) * HOUR;
    }
    if (fromHour !== null) {
      for (let h = fromHour; h < hourEnd; h += HOUR) {
        const r = s
          .prepare(
            `INSERT OR IGNORE INTO telemetry_1h (ts, gateway_id, peer_key, rx_bps, tx_bps, rtt_ms)
             SELECT ?, gateway_id, peer_key, AVG(rx_bps), AVG(tx_bps), AVG(rtt_ms)
             FROM telemetry_1m WHERE ts >= ? AND ts < ? GROUP BY gateway_id, peer_key`,
          )
          .run(h, h, h + HOUR);
        hours += r.changes;
        s.prepare(
          `INSERT OR IGNORE INTO pair_1h (ts, gateway_id, from_slug, to_slug, bps)
           SELECT ?, gateway_id, from_slug, to_slug, AVG(bps)
           FROM pair_1m WHERE ts >= ? AND ts < ? GROUP BY gateway_id, from_slug, to_slug`,
        ).run(h, h, h + HOUR);
      }
    }
    s.prepare("DELETE FROM telemetry_5s WHERE ts < ?").run(at - RETENTION.raw5s);
    s.prepare("DELETE FROM pair_5s WHERE ts < ?").run(at - RETENTION.raw5s);
    s.prepare("DELETE FROM telemetry_1m WHERE ts < ?").run(at - RETENTION.min1);
    s.prepare("DELETE FROM pair_1m WHERE ts < ?").run(at - RETENTION.min1);
    s.prepare("DELETE FROM telemetry_1h WHERE ts < ?").run(at - RETENTION.hour1);
    s.prepare("DELETE FROM pair_1h WHERE ts < ?").run(at - RETENTION.hour1);
  })();
  g.__opnmeshRollup = { minute: minuteEnd, hour: hourEnd };

  return { minutes, hours };
}

// ---------------------------------------------------------------------------
// Queries for charts

export type Range = "1h" | "6h" | "24h" | "7d" | "30d" | "1y";

const RANGE_MS: Record<Range, number> = { "1h": HOUR, "6h": 6 * HOUR, "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR, "1y": 365 * 24 * HOUR };

export const RANGES: Range[] = ["1h", "6h", "24h", "7d", "30d", "1y"];

export function rangeMs(r: Range): number {
  return RANGE_MS[r];
}

/** Which rollup table serves a range: 5 s samples for hours, minutes for days, hours for months. */
function tableFor(range: Range): { name: "telemetry_5s" | "telemetry_1m" | "telemetry_1h"; resolution: number } {
  if (range === "1h" || range === "6h") return { name: "telemetry_5s", resolution: 5000 };
  if (range === "24h" || range === "7d") return { name: "telemetry_1m", resolution: MIN };
  return { name: "telemetry_1h", resolution: HOUR };
}

export interface SitePoint {
  ts: number;
  inBps: number;
  outBps: number;
}

/**
 * A gateway's total throughput (all peers summed) over a range, bucketed to
 * at most ~600 points so a year renders as fast as an hour.
 */
export function siteSeries(gatewayId: string, range: Range, at = now()): SitePoint[] {
  const { name, resolution } = tableFor(range);
  const since = at - RANGE_MS[range];
  const bucket = Math.max(resolution, Math.ceil(RANGE_MS[range] / 600 / resolution) * resolution);
  // The bucket is an integer literal in the SQL so the division stays integer
  // division; a bound parameter can arrive as REAL and defeat the rounding.
  const rows = getDb()
    .$client.prepare(
      `SELECT (ts / ${Math.floor(bucket)}) * ${Math.floor(bucket)} AS b, AVG(rx) AS rx, AVG(tx) AS tx
       FROM (SELECT ts, SUM(rx_bps) AS rx, SUM(tx_bps) AS tx FROM ${name} WHERE gateway_id = ? AND ts >= ? GROUP BY ts)
       GROUP BY b ORDER BY b`,
    )
    .all(gatewayId, since) as Array<{ b: number; rx: number; tx: number }>;
  return rows.map((r) => ({ ts: r.b, inBps: r.rx, outBps: r.tx }));
}

export interface SeriesPoint {
  ts: number;
  rxBps: number;
  txBps: number;
  rttMs: number | null;
}

/** Per-peer series for one gateway. 1h/6h from 5 s samples, 24h/7d from 1 m, 30d from 1 h. */
export function peerSeries(gatewayId: string, peerKey: string, range: Range, at = now()): SeriesPoint[] {
  const db = getDb();
  const since = at - RANGE_MS[range];
  const table = range === "1h" || range === "6h" ? telemetry5s : range === "30d" || range === "1y" ? telemetry1h : telemetry1m;
  const rows = db
    .select({ ts: table.ts, rxBps: table.rxBps, txBps: table.txBps, rttMs: table.rttMs })
    .from(table)
    .where(and(sql`${table.gatewayId} = ${gatewayId}`, sql`${table.peerKey} = ${peerKey}`, gte(table.ts, since)))
    .orderBy(table.ts)
    .all();
  return rows.map((r) => ({ ts: r.ts, rxBps: r.rxBps, txBps: r.txBps, rttMs: r.rttMs }));
}

export interface PairPoint {
  ts: number;
  bps: number;
}

/** Routed bytes/s from one site slug to another over a range, max across reporting gateways. */
export function pairSeries(fromSlug: string, toSlug: string, range: Range, at = now()): PairPoint[] {
  const db = getDb();
  const since = at - RANGE_MS[range];
  const table = range === "1h" || range === "6h" ? pair5s : range === "30d" || range === "1y" ? pair1h : pair1m;
  const rows = db
    .select({ ts: table.ts, bps: sql<number>`MAX(${table.bps})` })
    .from(table)
    .where(and(sql`${table.fromSlug} = ${fromSlug}`, sql`${table.toSlug} = ${toSlug}`, gte(table.ts, since), lt(table.ts, at + 1)))
    .groupBy(table.ts)
    .orderBy(table.ts)
    .all();
  return rows.map((r) => ({ ts: r.ts, bps: Number(r.bps) }));
}
