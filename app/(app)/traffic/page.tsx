import { requireAdmin } from "@/server/session";
import { buildState } from "@/server/state";
import { pairSeries, rangeMs, RANGES, type Range } from "@/server/telemetry";
import { meshSites } from "@/core/topology";
import { getGenerated } from "@/server/snapshot";
import { TrafficView, type PairHistory } from "@/ui/traffic-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Traffic" };

export default async function TrafficPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  await requireAdmin();
  const { range: r } = await searchParams;
  const range: Range = RANGES.includes(r as Range) ? (r as Range) : "1h";
  const state = buildState();
  const snap = getGenerated().snapshot;
  const sites = meshSites(snap);
  const now = Date.now();
  const history: PairHistory[] = [];
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i]!;
      const b = sites[j]!;
      history.push({
        aId: a.id,
        bId: b.id,
        aToB: pairSeries(a.slug, b.slug, range, now).map((p) => ({ ts: p.ts, v: p.bps })),
        bToA: pairSeries(b.slug, a.slug, range, now).map((p) => ({ ts: p.ts, v: p.bps })),
      });
    }
  }
  return <TrafficView initial={state} range={range} ranges={RANGES} history={history} from={now - rangeMs(range)} to={now} />;
}
