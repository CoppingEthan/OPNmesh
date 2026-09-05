/**
 * The last two minutes of per-site throughput, sampled once a second from
 * live state, so a freshly opened dashboard can draw the "live" graph
 * immediately and every viewer sees the same curve. In memory only; the
 * durable history comes from the telemetry tables.
 */
import { liveState } from "./live";
import { getGenerated } from "./snapshot";
import { meshSites } from "@/core/topology";

export const LIVE_WINDOW = 120;

export interface LiveSeriesPayload {
  ts: number[];
  sites: Record<string, { in: number[]; out: number[] }>;
}

interface Sample {
  ts: number;
  rates: Record<string, { in: number; out: number }>;
}

class LiveSeries {
  private samples: Sample[] = [];

  sample(at: number): void {
    const gen = getGenerated();
    const live = liveState();
    const rates: Record<string, { in: number; out: number }> = {};
    for (const s of meshSites(gen.snapshot)) {
      const l = live.get(s.gateway.id);
      let inn = 0;
      let out = 0;
      if (l) {
        for (const r of l.peerRates.values()) {
          inn += r.rxBps;
          out += r.txBps;
        }
      }
      rates[s.id] = { in: inn, out };
    }
    this.samples.push({ ts: at, rates });
    if (this.samples.length > LIVE_WINDOW) this.samples.splice(0, this.samples.length - LIVE_WINDOW);
  }

  /** Current per-site rates from the most recent sample. */
  current(): Record<string, { in: number; out: number }> {
    return this.samples[this.samples.length - 1]?.rates ?? {};
  }

  payload(): LiveSeriesPayload {
    const ts = this.samples.map((s) => s.ts);
    const sites: Record<string, { in: number[]; out: number[] }> = {};
    const ids = new Set<string>();
    for (const s of this.samples) for (const id of Object.keys(s.rates)) ids.add(id);
    for (const id of ids) {
      sites[id] = { in: this.samples.map((s) => s.rates[id]?.in ?? 0), out: this.samples.map((s) => s.rates[id]?.out ?? 0) };
    }
    return { ts, sites };
  }

  clearForTests(): void {
    this.samples = [];
  }
}

const g = globalThis as unknown as { __opnmeshLiveSeries?: LiveSeries };

export function liveSeries(): LiveSeries {
  if (!g.__opnmeshLiveSeries) g.__opnmeshLiveSeries = new LiveSeries();
  return g.__opnmeshLiveSeries;
}
