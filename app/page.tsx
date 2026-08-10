import { requireAdmin } from "../lib/ui/auth.js";
import { loadSites } from "../lib/ui/sites.js";
import { control } from "../lib/ui/control.js";
import { HealthBadge, HandshakeAge, ago, bytes, healthOf } from "./ui.js";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  await requireAdmin();
  const sites = loadSites();
  const state = await control.state().catch(() => ({ nodes: {} as Record<string, never> }));

  const keyToSite = new Map(sites.cfg.sites.map((s) => [s.gateway.publicKey, s.id]));
  const keyToClient = new Map(sites.cfg.clients.map((c) => [c.publicKey, c.id]));
  const nameOf = (k: string) => keyToSite.get(k) ?? keyToClient.get(k) ?? k.slice(0, 12) + "…";

  const warnings = sites.findings.filter((f) => f.level === "warning");
  const errors = sites.findings.filter((f) => f.level === "error");

  return (
    <div className="space-y-6">
      <h1 className="h1">Mesh overview</h1>

      {errors.length > 0 && (
        <div className="card border-red-900">
          <div className="label mb-2 text-red-400">Configuration errors</div>
          {errors.map((f, i) => (
            <p key={i} className="status-bad text-sm">{f.message}</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {sites.cfg.sites.map((s) => {
          const n = (state.nodes as Record<string, any>)[s.id];
          const health = healthOf(n?.lastSeen ?? null, n?.lastError ?? "", n?.drift ?? false);
          return (
            <div key={s.id} className="card">
              <div className="flex items-baseline justify-between">
                <div>
                  <span className="font-medium text-zinc-100">{s.gateway.displayName ?? s.id}</span>{" "}
                  <span className="mono text-xs text-zinc-500">{s.id}</span>
                </div>
                <HealthBadge health={health} />
              </div>
              <div className="mono mt-2 space-y-0.5 text-xs text-zinc-400">
                <div>lan {s.lan}</div>
                <div>
                  tunnel {s.gateway.tunnelIp} · udp/{s.gateway.listenPort}
                </div>
                <div>
                  {s.gateway.endpoint ?? "dynamic endpoint"} · seen {ago(n?.lastSeen ?? null)}
                  {n?.version ? ` · v${n.version}` : ""}
                </div>
              </div>
              {n?.lastError && <p className="status-bad mt-2 text-xs">{n.lastError}</p>}
              {n?.drift && <p className="status-warn mt-1 text-xs">config drift</p>}
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="label mb-3">Connectivity matrix</div>
        <table className="data">
          <thead>
            <tr>
              <th>Pair</th>
              <th>Path</th>
              <th>Consequence</th>
            </tr>
          </thead>
          <tbody>
            {sites.matrix.map((e) => (
              <tr key={`${e.a}|${e.b}`}>
                <td className="mono">
                  {e.a} ↔ {e.b}
                </td>
                <td>
                  {e.status.kind === "direct" && <span className="status-ok">direct</span>}
                  {e.status.kind === "transit" && (
                    <span className="status-warn">transit via {e.status.via}</span>
                  )}
                  {e.status.kind === "unreachable" && <span className="status-bad">unreachable</span>}
                </td>
                <td className="text-zinc-400">
                  {e.status.kind === "transit"
                    ? `severed if ${e.status.via} dies`
                    : e.status.kind === "direct"
                      ? "no transit dependency"
                      : "no path — open a UDP port or add a hub"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sites.spof
          .filter((r) => r.severedPairs.length > 0)
          .map((r) => (
            <p key={r.siteId} className="status-warn mt-2 text-sm">
              Losing {r.siteId} severs: {r.severedPairs.map(([a, b]) => `${a} ↔ ${b}`).join(", ")}
            </p>
          ))}
      </div>

      <div className="card">
        <div className="label mb-3">Tunnels</div>
        <table className="data">
          <thead>
            <tr>
              <th>Node</th>
              <th>Peer</th>
              <th>Handshake</th>
              <th>Received</th>
              <th>Sent</th>
              <th>Endpoint</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(state.nodes as Record<string, any>).flatMap(([id, n]) =>
              (n?.peers ?? []).map((p: any) => (
                <tr key={`${id}|${p.publicKey}`}>
                  <td className="mono">{id}</td>
                  <td className="mono">{nameOf(p.publicKey)}</td>
                  <td>
                    <HandshakeAge unixSec={p.latestHandshake} />
                  </td>
                  <td className="mono">{bytes(p.rxBytes)}</td>
                  <td className="mono">{bytes(p.txBytes)}</td>
                  <td className="mono text-zinc-500">{p.endpoint || "—"}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>

      {warnings.length > 0 && (
        <div className="card border-amber-900">
          <div className="label mb-2 text-amber-400">Warnings</div>
          {warnings.map((f, i) => (
            <p key={i} className="status-warn text-sm">{f.message}</p>
          ))}
        </div>
      )}
    </div>
  );
}
