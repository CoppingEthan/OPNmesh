"use client";

import { AlertTriangle, ArrowRight, XCircle } from "lucide-react";
import Link from "next/link";
import type { StatePayload } from "@/server/state";
import { Badge, Card, EmptyState, LinkButton, StatusDot, cx, healthLabel, healthTone } from "./components";
import { Ago } from "./components-client";
import { EasedBits } from "./eased";
import { LAYOUT_LABEL } from "./format";
import { MeshMap } from "./mesh-map";
import { SiteTrafficGraph, siteColors } from "./site-traffic-graph";
import { useLiveState } from "./use-live";

interface EventRow {
  id: number;
  ts: number;
  kind: string;
  message: string;
  actor: string;
}

export function Overview({ initial, events }: { initial: StatePayload; events: EventRow[] }) {
  // The overview asks for per-second reports while it is open.
  const { state } = useLiveState(initial, { fast: true });
  const inMesh = state.sites.filter((s) => s.inMesh);
  const online = state.clients.filter((c) => c.online).length;
  const totalIn = state.pairs.reduce((a, p) => a + p.bps, 0);
  const problems = state.findings;
  const colors = siteColors(state);
  const rateOf = (siteId: string) => state.siteRates.find((r) => r.siteId === siteId);

  return (
    <div className="space-y-6">
      {state.sites.length === 0 ? (
        <EmptyState
          title="Start by adding a site"
          description="A site is a location with its own router and networks. After you create one, OPNmesh gives you a one-line command to install its gateway."
          action={<LinkButton href="/sites?new=1" variant="primary">Add your first site</LinkButton>}
        />
      ) : (
        /* Top row: the map (about two thirds) with the four headline figures stacked beside it. */
        <div className="grid gap-4 lg:grid-cols-[13fr_7fr]">
          <Card padded={false} className="min-w-0">
            <div className="p-3 md:p-4">
              <MeshMap state={state} height={Math.max(320, Math.min(420, 250 + inMesh.length * 30))} />
            </div>
          </Card>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-1 lg:grid-rows-4">
            <Tile label="Sites online" value={`${inMesh.filter((s) => s.gateway?.health === "online").length} / ${state.sites.length}`} />
            <Tile label="Tunnels up" value={`${state.tunnels.filter((t) => t.kind === "direct" && t.health === "up").length} / ${state.tunnels.filter((t) => t.kind === "direct").length}`} />
            <Tile label="Clients online" value={`${online} / ${state.clients.length}`} />
            <Tile label="Traffic between sites" value={<EasedBits value={totalIn} tauMs={2200} />} />
          </div>
        </div>
      )}

      {inMesh.length > 0 && <SiteTrafficGraph state={state} />}

      {problems.length > 0 && (
        <Card title="Worth your attention">
          <ul className="space-y-2 text-sm">
            {problems.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                {f.level === "error" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-bad" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />}
                <span className="text-ink-2">
                  {f.message}
                  {f.subject && f.subject.kind !== "settings" && (
                    <Link href={f.subject.kind === "site" ? `/sites/${f.subject.id}` : `/clients/${f.subject.id}`} className="ml-1 text-brand-ink underline-offset-2 hover:underline">
                      open
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!state.settings.alertsConfigured && inMesh.length > 0 && (
        <p className="text-xs text-ink-3">
          Email alerts are not set up yet: <Link href="/settings" className="text-brand-ink hover:underline">add an SMTP server in Settings</Link> to be told when a gateway stops responding.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Sites" className="lg:col-span-2" actions={<Link href="/sites" className="text-xs text-brand-ink hover:underline">Manage</Link>} padded={false}>
          <ul className="divide-y divide-line">
            {state.sites.map((s) => {
              const g = s.gateway;
              const tone = g ? (g.attention && g.health === "online" ? "warn" : healthTone(g.health)) : "idle";
              const rate = rateOf(s.id);
              return (
                <li key={s.id}>
                  <Link href={`/sites/${s.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-surface-2">
                    <StatusDot tone={tone} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.inMesh ? colors.get(s.id) : "var(--idle)" }} aria-hidden />
                        <span className="font-medium text-ink">{s.name}</span>
                        <span className="text-xs text-ink-3">{LAYOUT_LABEL[s.routerLayout]}</span>
                      </div>
                      <div className="mono truncate text-xs text-ink-3">{s.lans.filter((l) => l.shared).map((l) => l.cidr).join("  ") || "no networks yet"}</div>
                    </div>
                    {rate && (
                      <div className="tnum hidden shrink-0 text-right text-xs text-ink-2 sm:block">
                        <div>
                          <span className="text-ink-3">in</span> <span className="text-ink"><EasedBits value={rate.inBps} /></span>
                        </div>
                        <div>
                          <span className="text-ink-3">out</span> <span className="text-ink"><EasedBits value={rate.outBps} /></span>
                        </div>
                      </div>
                    )}
                    <div className="w-28 shrink-0 text-right text-xs text-ink-2">
                      {g ? (
                        <>
                          <div>{g.attention && g.health === "online" ? "Needs attention" : healthLabel(g.health)}</div>
                          <div className="text-ink-3">
                            <Ago ts={g.lastSeenAt} />
                          </div>
                        </>
                      ) : (
                        <Badge tone="idle">No gateway</Badge>
                      )}
                    </div>
                    <ArrowRight className="h-4 w-4 text-ink-3" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Recent activity" actions={<Link href="/events" className="text-xs text-brand-ink hover:underline">All events</Link>} padded={false}>
          <ul className="divide-y divide-line">
            {events.length === 0 && <li className="px-5 py-6 text-sm text-ink-3">Nothing has happened yet.</li>}
            {events.map((e) => (
              <li key={e.id} className="px-5 py-2.5 text-sm">
                <div className="text-ink">{e.message}</div>
                <div className="text-xs text-ink-3">
                  <Ago ts={e.ts} /> · {e.actor}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="glass flex flex-col justify-center rounded-card px-4 py-3">
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-ink">{value}</div>
    </div>
  );
}
