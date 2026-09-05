/**
 * Live state: the most recent telemetry from every gateway, the throughput
 * derived from successive reports, and the subscribers waiting for updates.
 * Kept in memory; rebuilt as gateways report after a restart.
 *
 * Rates are computed here rather than on the gateway so the agent stays
 * stateless: it sends cumulative counters, the controller differences them.
 */
import { z } from "zod";

export const peerReportSchema = z.object({
  publicKey: z.string().min(40).max(48),
  endpoint: z.string().max(64).nullable().default(null),
  latestHandshake: z.number().int().min(0).default(0),
  rxBytes: z.number().int().min(0),
  txBytes: z.number().int().min(0),
  rttMs: z.number().min(0).max(60_000).nullable().default(null),
});

export const pairReportSchema = z.object({
  name: z.string().min(1).max(120),
  bytes: z.number().int().min(0),
  packets: z.number().int().min(0),
});

export const telemetrySchema = z.object({
  version: z.string().max(32).default(""),
  uptimeSeconds: z.number().int().min(0).default(0),
  appliedHash: z.string().max(64).default(""),
  diskHash: z.string().max(64).default(""),
  lastError: z.string().max(2000).default(""),
  interfaceUp: z.boolean().default(true),
  peers: z.array(peerReportSchema).max(1000).default([]),
  counters: z.array(pairReportSchema).max(5000).default([]),
  host: z
    .object({
      load1: z.number().min(0).nullable().default(null),
      memUsedPct: z.number().min(0).max(100).nullable().default(null),
      addresses: z.array(z.string().max(64)).max(32).default([]),
      kernel: z.string().max(64).default(""),
    })
    .default({ load1: null, memUsedPct: null, addresses: [], kernel: "" }),
});

export type TelemetryReport = z.infer<typeof telemetrySchema>;
export type PeerReport = z.infer<typeof peerReportSchema>;

export interface PeerRate {
  rxBps: number;
  txBps: number;
}

export interface LiveGateway {
  gatewayId: string;
  siteId: string;
  at: number;
  report: TelemetryReport;
  peerRates: Map<string, PeerRate>;
  /** counter name → bytes per second */
  counterRates: Map<string, number>;
}

export interface IngestResult {
  live: LiveGateway;
  /** True when a previous report existed and rates could be computed. */
  hasRates: boolean;
}

/** How long gateways keep reporting every second after the last overview closes. */
export const FAST_MODE_GRACE_MS = 20_000;

export class LiveState {
  private gateways = new Map<string, LiveGateway>();
  private listeners = new Set<() => void>();
  private fastViewers = 0;
  private lastFastViewerLeft = 0;
  /** Bumps on every change, so derived views can be cached until it moves. */
  generation = 0;

  /** An overview page is open: gateways are asked to report every second. */
  addFastViewer(): void {
    this.fastViewers++;
  }

  removeFastViewer(): void {
    this.fastViewers = Math.max(0, this.fastViewers - 1);
    if (this.fastViewers === 0) this.lastFastViewerLeft = Date.now();
  }

  fastMode(now = Date.now()): boolean {
    return this.fastViewers > 0 || now - this.lastFastViewerLeft < FAST_MODE_GRACE_MS;
  }

  /** Tests: drop viewers and the grace window. */
  resetFastModeForTests(): void {
    this.fastViewers = 0;
    this.lastFastViewerLeft = 0;
  }

  ingest(gatewayId: string, siteId: string, report: TelemetryReport, at: number): IngestResult {
    this.generation++;
    const prev = this.gateways.get(gatewayId);
    const peerRates = new Map<string, PeerRate>();
    const counterRates = new Map<string, number>();
    let hasRates = false;
    if (prev && prev.siteId === siteId) {
      const dt = (at - prev.at) / 1000;
      if (dt >= 0.5 && dt <= 300) {
        hasRates = true;
        const before = new Map(prev.report.peers.map((p) => [p.publicKey, p]));
        for (const p of report.peers) {
          const b = before.get(p.publicKey);
          if (!b) continue;
          // A negative delta means the interface was recreated, not negative traffic.
          peerRates.set(p.publicKey, {
            rxBps: Math.max(0, p.rxBytes - b.rxBytes) / dt,
            txBps: Math.max(0, p.txBytes - b.txBytes) / dt,
          });
        }
        const beforeC = new Map(prev.report.counters.map((c) => [c.name, c]));
        for (const c of report.counters) {
          const b = beforeC.get(c.name);
          if (!b) continue;
          counterRates.set(c.name, Math.max(0, c.bytes - b.bytes) / dt);
        }
      }
    }
    const live: LiveGateway = { gatewayId, siteId, at, report, peerRates, counterRates };
    this.gateways.set(gatewayId, live);
    this.notify();
    return { live, hasRates };
  }

  get(gatewayId: string): LiveGateway | undefined {
    return this.gateways.get(gatewayId);
  }

  all(): LiveGateway[] {
    return [...this.gateways.values()];
  }

  forget(gatewayId: string): void {
    this.gateways.delete(gatewayId);
    this.generation++;
    this.notify();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* a broken subscriber must not break ingest */
      }
    }
  }

  clearForTests(): void {
    this.gateways.clear();
  }
}

const g = globalThis as unknown as { __opnmeshLive?: LiveState };

export function liveState(): LiveState {
  if (!g.__opnmeshLive) g.__opnmeshLive = new LiveState();
  return g.__opnmeshLive;
}
