import { requireAdmin } from "../../lib/ui/auth.js";
import { loadSites, configHistory } from "../../lib/ui/sites.js";
import { control } from "../../lib/ui/control.js";

export const dynamic = "force-dynamic";

export default async function ConfigPage() {
  await requireAdmin();
  const sites = loadSites();
  const [state, history] = await Promise.all([
    control.state().catch(() => ({ nodes: {} as Record<string, any> })),
    configHistory(),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="h1">Generated configuration</h1>
      <p className="text-sm text-zinc-400">
        Exactly what each agent pulls, generated from sites.yml. A node whose applied hash differs
        from desired is mid-reconcile (or drifted — see Dashboard).
      </p>

      {sites.cfg.sites.map((s) => {
        const n = (state.nodes as Record<string, any>)[s.id];
        const inSync = n && n.diskHash === n.desiredHash;
        return (
          <div key={s.id} className="card">
            <div className="mb-3 flex items-baseline justify-between">
              <span className="mono text-sm text-zinc-100">{s.id}</span>
              <span className={inSync ? "status-ok text-xs" : "status-warn text-xs"}>
                {n ? (inSync ? "in sync" : "reconciling / drifted") : "no report yet"}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {Object.entries(sites.bundle.nodes[s.id]!.files).map(([name, content]) => (
                <div key={name}>
                  <div className="label mb-1">{name}</div>
                  <pre className="conf max-h-80 overflow-y-auto">{content}</pre>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div className="card">
        <div className="label mb-3">Change history (local config repository — never pushed anywhere)</div>
        <table className="data">
          <thead>
            <tr>
              <th>Commit</th>
              <th>When</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.hash}>
                <td className="mono">{h.hash}</td>
                <td className="text-zinc-400">{h.date}</td>
                <td>{h.message}</td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr>
                <td colSpan={3} className="text-zinc-500">
                  No changes recorded yet — the repository is created on the first edit made here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
