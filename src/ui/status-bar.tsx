"use client";

/**
 * The bar across the top of every page: one plain-language verdict, then the
 * counts that back it up, then the state of the mesh's configuration.
 *
 * It refreshes by polling the state endpoint every few seconds rather than
 * opening a second live stream, because none of these counts change faster
 * than that and a page already showing live figures should keep its one
 * stream to itself.
 */
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { StatePayload } from "@/server/state";
import { apiFetch } from "./api";
import { cx } from "./components";
import { summarise, type StatusSummary } from "./status-summary";

const DOT: Record<StatusSummary["level"], string> = { ok: "bg-good", warn: "bg-warn", bad: "bg-bad", empty: "bg-idle" };

function Pill({ count, total, label, tone }: { count: number; total: number; label: string; tone: "good" | "warn" | "bad" }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1">
      <span className={cx("inline-block h-1.5 w-1.5 rounded-full", tone === "good" ? "bg-good" : tone === "warn" ? "bg-warn" : "bg-bad")} />
      <span className="tnum font-semibold text-ink">
        {count}/{total}
      </span>
      <span className="text-ink-2">{label}</span>
    </span>
  );
}

export function StatusBar({ initial }: { initial: StatusSummary }) {
  const [s, setS] = useState(initial);
  const version = initial.version;
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const state = await apiFetch<StatePayload>("GET", "/api/admin/state");
        if (!cancelled) setS(summarise(state, version));
      } catch {
        /* a missed poll is not worth reporting; the next one will do */
      }
    };
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [version]);

  const Icon = s.level === "ok" ? CheckCircle2 : s.level === "warn" ? AlertTriangle : s.level === "bad" ? XCircle : Info;
  const tone = s.level === "ok" ? "text-good" : s.level === "warn" ? "text-warn" : s.level === "bad" ? "text-bad" : "text-ink-3";
  const ratio = (a: number, b: number): "good" | "warn" | "bad" => (b === 0 ? "warn" : a === b ? "good" : a === 0 ? "bad" : "warn");

  return (
    <div className="glass-panel sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 text-xs md:px-8">
      <span className="inline-flex items-center gap-2">
        <Icon className={cx("h-4 w-4", tone)} />
        <span className="font-semibold text-ink">{s.title}</span>
      </span>
      {s.sitesTotal > 0 && (
        <>
          <Pill count={s.sitesOnline} total={s.sitesTotal} label={s.sitesTotal === 1 ? "site online" : "sites online"} tone={ratio(s.sitesOnline, s.sitesTotal)} />
          {s.tunnelsTotal > 0 && <Pill count={s.tunnelsUp} total={s.tunnelsTotal} label={s.tunnelsTotal === 1 ? "tunnel up" : "tunnels up"} tone={ratio(s.tunnelsUp, s.tunnelsTotal)} />}
          {s.clientsTotal > 0 && <Pill count={s.clientsOnline} total={s.clientsTotal} label={s.clientsTotal === 1 ? "client online" : "clients online"} tone={s.clientsOnline > 0 ? "good" : "warn"} />}
        </>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
        {s.syncTotal > 0 && (
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className={cx("h-4 w-4", s.inSync === s.syncTotal ? "text-good" : "text-warn")} />
            <span className="tnum text-ink-2">
              {s.inSync}/{s.syncTotal} in sync
            </span>
          </span>
        )}
        <span className="mono text-ink-3">v{s.version}</span>
        <span className="inline-flex items-center gap-2">
          {s.problems === 0 ? <CheckCircle2 className="h-4 w-4 text-good" /> : <AlertTriangle className="h-4 w-4 text-warn" />}
          <span className="text-ink-2">{s.problems === 0 ? "Nothing needs attention" : `${s.problems} need${s.problems === 1 ? "s" : ""} attention`}</span>
        </span>
        <span className={cx("inline-block h-2 w-2 rounded-full", DOT[s.level], s.level === "ok" && "pulse-good")} aria-hidden />
      </div>
    </div>
  );
}
