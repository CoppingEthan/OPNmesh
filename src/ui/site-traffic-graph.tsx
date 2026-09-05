"use client";

/**
 * The master traffic graph on the overview: one line per site, all sites
 * overlaid in their own colours. "Live" shows the last 60 seconds from the
 * per-second stream; the history ranges come from the telemetry rollups
 * (5 s samples for hours, minutes for days, hours for months and the year).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StatePayload } from "@/server/state";
import type { Range } from "@/server/telemetry";
import { apiFetch } from "./api";
import { LineChart } from "./charts";
import { Card, cx } from "./components";
import { formatBits } from "./format";

const SERIES_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)", "var(--series-7)", "var(--series-8)"];
const RANGES: Array<{ key: "live" | Range; label: string; ms: number }> = [
  { key: "live", label: "Live", ms: 60_000 },
  { key: "1h", label: "1 hour", ms: 3_600_000 },
  { key: "6h", label: "6 hours", ms: 6 * 3_600_000 },
  { key: "24h", label: "24 hours", ms: 24 * 3_600_000 },
  { key: "7d", label: "7 days", ms: 7 * 24 * 3_600_000 },
  { key: "30d", label: "30 days", ms: 30 * 24 * 3_600_000 },
  { key: "1y", label: "1 year", ms: 365 * 24 * 3_600_000 },
];
type Metric = "total" | "in" | "out";

interface HistoryPoint {
  ts: number;
  inBps: number;
  outBps: number;
}

/** Colour follows the site, not its position: assigned once by stable order. */
export function siteColors(state: StatePayload): Map<string, string> {
  const ordered = [...state.sites].sort((a, b) => a.hubPriority - b.hubPriority || a.slug.localeCompare(b.slug));
  return new Map(ordered.map((s, i) => [s.id, SERIES_COLORS[i % SERIES_COLORS.length]!]));
}

export function SiteTrafficGraph({ state }: { state: StatePayload }) {
  const [range, setRange] = useState<"live" | Range>("live");
  const [metric, setMetric] = useState<Metric>("total");
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({});
  const [loading, setLoading] = useState(false);
  const colors = useMemo(() => siteColors(state), [state]);
  const meshSites = state.sites.filter((s) => s.inMesh);

  // The live plot scrolls against the controller's clock, so keep the
  // offset between it and this browser from the latest payload.
  const offsetRef = useRef(0);
  useEffect(() => {
    offsetRef.current = state.at - Date.now();
  }, [state.at]);
  const clock = useCallback(() => Date.now() + offsetRef.current, []);
  const live = useMemo(() => (range === "live" ? { clock, lagMs: 1500 } : undefined), [range, clock]);

  // History ranges are fetched on demand and refreshed every 30 s.
  useEffect(() => {
    if (range === "live") return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const r = await apiFetch<{ sites: Array<{ siteId: string; points: HistoryPoint[] }> }>("GET", `/api/admin/traffic?range=${range}&sites=1`);
        if (!cancelled) setHistory(Object.fromEntries(r.sites.map((s) => [s.siteId, s.points])));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [range]);

  const pick = (p: { inBps: number; outBps: number }) => (metric === "in" ? p.inBps : metric === "out" ? p.outBps : p.inBps + p.outBps);
  const now = state.at;
  const spec = RANGES.find((r) => r.key === range)!;
  const to = range === "live" ? (state.liveSeries.ts[state.liveSeries.ts.length - 1] ?? now) : now;
  const from = to - spec.ms;

  const series = meshSites.map((s) => {
    let points: Array<{ ts: number; v: number }>;
    if (range === "live") {
      const ls = state.liveSeries.sites[s.id];
      // A few seconds before the window too, so the line runs off the left edge while it scrolls.
      points = ls ? state.liveSeries.ts.map((ts, i) => ({ ts, v: pick({ inBps: ls.in[i] ?? 0, outBps: ls.out[i] ?? 0 }) })).filter((p) => p.ts >= from - 5000) : [];
    } else {
      points = (history[s.id] ?? []).map((p) => ({ ts: p.ts, v: pick(p) }));
    }
    return { name: s.name, color: colors.get(s.id)!, points };
  });

  return (
    <Card
      title="Traffic through each site"
      actions={
        <div className="flex flex-wrap items-center gap-1">
          {(["total", "in", "out"] as Metric[]).map((m) => (
            <button key={m} type="button" onClick={() => setMetric(m)} className={cx("rounded-md px-2 py-1 text-xs", metric === m ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:text-ink")}>
              {m === "total" ? "Total" : m === "in" ? "In" : "Out"}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-line" />
          {RANGES.map((r) => (
            <button key={r.key} type="button" onClick={() => setRange(r.key)} className={cx("rounded-md px-2 py-1 text-xs", range === r.key ? "bg-brand-soft font-medium text-brand-ink" : "text-ink-2 hover:text-ink")}>
              {r.label}
            </button>
          ))}
        </div>
      }
      padded={false}
    >
      <div className={cx("pb-2 pt-3 transition-opacity", loading && "opacity-60")}>
        {meshSites.length === 0 ? (
          <p className="px-3 py-8 text-sm text-ink-3">The graph appears once a gateway is online.</p>
        ) : (
          // The sites list below carries the colour key, so the chart needs no legend.
          <LineChart series={series} from={from} to={to} height={290} formatValue={formatBits} ariaLabel="Traffic through each site" live={live} yAxis={false} />
        )}
      </div>
    </Card>
  );
}
