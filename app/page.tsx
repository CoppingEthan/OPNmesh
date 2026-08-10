import Link from "next/link";
import { requireAdmin } from "../lib/ui/auth.js";
import { loadSites } from "../lib/ui/sites.js";
import { control } from "../lib/ui/control.js";
import { buildMeshGraph, type LiveNodeState } from "../lib/ui/graph.js";
import { toRateLookup } from "../lib/ui/rates.js";
import MeshDiagram from "./MeshDiagram.js";
import { ago, healthOf } from "./ui.js";

export const dynamic = "force-dynamic";

/**
 * The dashboard answers one question first: is my network working? Everything
 * technical is available, but it sits below the plain-English answer.
 */
export default async function Dashboard() {
  await requireAdmin();
  const sites = loadSites();
  const state = await control
    .state()
    .catch(() => ({
      nodes: {} as Record<string, LiveNodeState | undefined>,
      rates: undefined as Record<string, { aToB: number; bToA: number }> | undefined,
    }));
  const live = state.nodes as Record<string, LiveNodeState | undefined>;
  const graph = buildMeshGraph(sites.cfg, live, toRateLookup(state.rates));

  const pending = await control.pending().catch(() => ({ pending: [] as Array<{ id: string }> }));

  const siteHealth = sites.cfg.sites.map((s) => {
    const n = live[s.id];
    return { site: s, health: healthOf(n?.lastSeen ?? null, n?.lastError ?? "", n?.drift ?? false), n };
  });
  const offline = siteHealth.filter((s) => s.health === "offline" || s.health === "unknown");
  const degraded = siteHealth.filter((s) => s.health === "degraded");
  const errors = sites.findings.filter((f) => f.level === "error");
  const warnings = sites.findings.filter((f) => f.level === "warning");

  const allWell = offline.length === 0 && degraded.length === 0 && errors.length === 0;
  const neverConnected = siteHealth.every((s) => s.n?.lastSeen == null);

  return (
    <div className="space-y-6">
      {/* --- the headline answer --- */}
      <div
        className={`rounded border p-5 ${
          errors.length > 0 || offline.length > 0
            ? "border-red-900 bg-red-950/30"
            : degraded.length > 0
              ? "border-amber-900 bg-amber-950/20"
              : "border-emerald-900 bg-emerald-950/20"
        }`}
      >
        <h1 className="text-xl font-semibold text-zinc-100">
          {neverConnected
            ? "Waiting for your first location to connect"
            : allWell
              ? "Everything is working"
              : offline.length > 0
                ? `${offline.length} of your ${siteHealth.length} locations ${offline.length === 1 ? "is" : "are"} not responding`
                : "Your network is up, but something needs attention"}
        </h1>
        <p className="mt-1 text-sm text-zinc-300">
          {neverConnected
            ? "No gateway has checked in yet. Add your first location from the Locations page, then run the install command it gives you."
            : allWell
              ? `All ${siteHealth.length} locations are online and every connection between them is healthy. Traffic is flowing normally.`
              : offline.length > 0
                ? `${offline.map((s) => s.site.name).join(", ")} stopped reporting. The other locations keep talking to each other — only traffic to and from ${offline.length === 1 ? "that site" : "those sites"} is affected.`
                : `${degraded.map((s) => s.site.name).join(", ")} is reachable but reporting a problem. See the details below.`}
        </p>
      </div>

      {errors.length > 0 && (
        <div className="card border-red-900">
          <div className="label mb-2 text-red-400">Your configuration has a problem</div>
          {errors.map((f, i) => (
            <p key={i} className="status-bad text-sm">
              {f.message}
            </p>
          ))}
        </div>
      )}

      {pending.pending.length > 0 && (
        <div className="card border-violet-900">
          <div className="label mb-1 text-violet-300">Waiting for your approval</div>
          <p className="text-sm text-zinc-300">
            {pending.pending.length} new{" "}
            {pending.pending.length === 1 ? "machine has" : "machines have"} asked to join your
            network. Nothing is configured until you approve.{" "}
            <Link href="/nodes" className="text-violet-300 underline">
              Review {pending.pending.length === 1 ? "it" : "them"}
            </Link>
          </p>
        </div>
      )}

      {/* --- the picture --- */}
      <MeshDiagram initial={graph} />

      {/* --- per-location summary in plain words --- */}
      <div className="card">
        <div className="label mb-3">Your locations</div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {siteHealth.map(({ site, health, n }) => (
            <div key={site.id} className="rounded border border-zinc-800 p-3">
              <div className="flex items-baseline justify-between">
                <span className="font-medium text-zinc-100">{site.name}</span>
                <span
                  className={
                    health === "active"
                      ? "status-ok text-xs"
                      : health === "degraded"
                        ? "status-warn text-xs"
                        : "status-bad text-xs"
                  }
                >
                  {health === "active"
                    ? "online"
                    : health === "degraded"
                      ? "needs attention"
                      : health === "offline"
                        ? "not responding"
                        : "never connected"}
                </span>
              </div>
              <p className="mt-1 text-sm text-zinc-400">
                {site.lans.length === 1
                  ? "One network"
                  : `${site.lans.length} networks (VLANs)`}
                {site.gateway.endpoint === null
                  ? " · connects outward only"
                  : " · accepts incoming connections"}
              </p>
              <div className="mono mt-2 space-y-0.5 text-xs text-zinc-500">
                {site.lans.map((l) => (
                  <div key={l.cidr}>
                    {l.cidr}
                    {l.name ? ` — ${l.name}` : ""}
                    {l.role === "guest" ? " (stays local)" : l.role === "management" ? " (restricted)" : ""}
                  </div>
                ))}
                <div>last checked in {ago(n?.lastSeen ?? null)}</div>
              </div>
              {n?.lastError && <p className="status-bad mt-2 text-xs">{n.lastError}</p>}
            </div>
          ))}
          {siteHealth.length === 0 && (
            <p className="text-sm text-zinc-500">
              No locations yet.{" "}
              <Link href="/nodes" className="text-emerald-400 underline">
                Add your first one
              </Link>
              .
            </p>
          )}
        </div>
      </div>

      {/* --- connectivity, explained --- */}
      <div className="card">
        <div className="label mb-3">How your locations reach each other</div>
        {sites.matrix.length === 0 ? (
          <p className="text-sm text-zinc-500">Add a second location to see connections here.</p>
        ) : (
          <div className="space-y-1 text-sm">
            {sites.matrix.map((e) => {
              const nameOf = (id: string) => sites.cfg.sites.find((s) => s.id === id)?.name ?? id;
              return (
                <div key={`${e.a}|${e.b}`} className="flex flex-wrap items-baseline gap-2">
                  <span className="text-zinc-200">
                    {nameOf(e.a)} ↔ {nameOf(e.b)}
                  </span>
                  {e.status.kind === "direct" && (
                    <span className="status-ok text-xs">
                      connects directly — no other site involved
                    </span>
                  )}
                  {e.status.kind === "transit" && (
                    <span className="status-warn text-xs">
                      routes through {nameOf(e.status.via)} — if {nameOf(e.status.via)} goes down,
                      these two lose contact
                    </span>
                  )}
                  {e.status.kind === "unreachable" && (
                    <span className="status-bad text-xs">
                      cannot connect — neither site accepts incoming connections
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="card border-amber-900">
          <div className="label mb-2 text-amber-400">Worth knowing</div>
          {warnings.map((f, i) => (
            <p key={i} className="status-warn text-sm">
              {f.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
