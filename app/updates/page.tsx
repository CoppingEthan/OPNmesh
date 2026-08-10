import { revalidatePath } from "next/cache";
import { requireAdmin } from "../../lib/ui/auth.js";
import { loadSites } from "../../lib/ui/sites.js";
import { control } from "../../lib/ui/control.js";
import { CONTROL_URL } from "../../lib/ui/env.js";
import { ago } from "../ui.js";

export const dynamic = "force-dynamic";

async function createRollout(formData: FormData) {
  "use server";
  await requireAdmin();
  const res = await control.createRollout({
    version: String(formData.get("version")),
    canary: String(formData.get("canary")),
    soakSec: Number(formData.get("soakSec") ?? 1800),
    failTimeoutSec: 300,
    approveConfigChange: formData.get("approveConfigChange") === "on",
  });
  const { redirect } = await import("next/navigation");
  if ((res as any)?.blocked) redirect("/updates?blocked=1");
  revalidatePath("/updates");
}

async function cancelRollout() {
  "use server";
  await requireAdmin();
  await control.cancelRollout();
  revalidatePath("/updates");
}

async function setFreeze(formData: FormData) {
  "use server";
  await requireAdmin();
  await control.freeze(formData.get("frozen") === "true");
  revalidatePath("/updates");
}

async function setWindow(formData: FormData) {
  "use server";
  await requireAdmin();
  await control.setWindow(String(formData.get("updateWindow")));
  revalidatePath("/updates");
}

export default async function UpdatesPage({
  searchParams,
}: {
  searchParams: Promise<{ blocked?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const sites = loadSites();
  const [{ rollout, settings }, audit, state, releases] = await Promise.all([
    control
      .rollout()
      .catch(() => ({ rollout: null, settings: { frozen: false, updateWindow: "always", pinned: {} as Record<string, boolean> } })),
    control.audit().catch(() => ({ audit: [] })),
    control.state().catch(() => ({ nodes: {} as Record<string, any> })),
    fetch(`${CONTROL_URL}/api/v1/admin/releases`, { cache: "no-store" })
      .then((r) => r.json() as Promise<{ releases: Array<{ version: string; sha256: string; configDigest: string | null }> }>)
      .catch(() => ({ releases: [] })),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="h1">Updates</h1>

      {params.blocked && (
        <div className="card border-red-900">
          <p className="status-bad text-sm">
            Rollout blocked: this release generates different WireGuard configuration for the current
            topology. Review the diff on the Config page, then re-create the rollout with explicit
            approval.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="card">
          <div className="label mb-2">Global freeze</div>
          <form action={setFreeze}>
            <input type="hidden" name="frozen" value={settings.frozen ? "false" : "true"} />
            <button className={`btn w-full ${settings.frozen ? "btn-danger" : ""}`} type="submit">
              {settings.frozen ? "FROZEN — click to unfreeze" : "Freeze all updates now"}
            </button>
          </form>
          <p className="mt-2 text-xs text-zinc-500">Takes effect immediately, including mid-rollout.</p>
        </div>
        <div className="card">
          <div className="label mb-2">Maintenance window</div>
          <form action={setWindow} className="flex gap-1">
            <select className="input" name="updateWindow" defaultValue={settings.updateWindow}>
              <option value="always">always (no window)</option>
              <option value="never">never (updates held)</option>
            </select>
            <button className="btn" type="submit">Set</button>
          </form>
        </div>
        <div className="card">
          <div className="label mb-2">Node versions</div>
          {sites.cfg.sites.map((s) => {
            const n = (state.nodes as Record<string, any>)[s.id];
            return (
              <div key={s.id} className="mono text-sm">
                {s.id}: v{n?.version || "?"}
                {settings.pinned[s.id] && <span className="status-warn"> (pinned)</span>}
                {n?.lastUpdateError && <span className="status-bad"> — {n.lastUpdateError}</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="label mb-3">Current rollout</div>
        {rollout ? (
          <div>
            <div className="mono text-sm">
              {rollout.version} — <span className={rollout.status === "done" ? "status-ok" : rollout.status === "aborted" ? "status-bad" : "status-warn"}>{rollout.status}</span>
              {rollout.abortReason && <span className="status-bad"> — {rollout.abortReason}</span>}
            </div>
            <div className="mono mt-2 flex gap-2 text-sm">
              {rollout.plan.map((node: string, i: number) => (
                <span
                  key={node}
                  className={
                    i < rollout.idx ? "status-ok" : i === rollout.idx && rollout.status === "running" ? "status-warn" : "status-dim"
                  }
                >
                  {node}
                  {i === 0 ? " (canary)" : ""}
                  {i < rollout.plan.length - 1 ? " →" : ""}
                </span>
              ))}
            </div>
            {rollout.status === "running" && (
              <form action={cancelRollout} className="mt-3">
                <button className="btn btn-danger" type="submit">Cancel rollout</button>
              </form>
            )}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">No rollout yet.</p>
        )}
      </div>

      <div className="card">
        <div className="label mb-3">Start a rollout</div>
        <form action={createRollout} className="flex flex-wrap items-end gap-2">
          <div>
            <div className="label">Release</div>
            <select className="input mono" name="version">
              {releases.releases.map((r) => (
                <option key={r.version} value={r.version}>
                  {r.version}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="label">Canary node</div>
            <select className="input mono" name="canary">
              {sites.cfg.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="label">Canary soak (s)</div>
            <input className="input mono w-24" name="soakSec" type="number" defaultValue={1800} min={0} />
          </div>
          <label className="flex items-center gap-1 text-xs text-zinc-400">
            <input type="checkbox" name="approveConfigChange" /> approve config-changing release
          </label>
          <button className="btn btn-primary" type="submit">Start staged rollout</button>
        </form>
        <p className="mt-2 text-xs text-zinc-500">
          One node at a time, canary first, hubs last, abort on first failure. Each node
          commit-confirms locally (handshake + check-in within 90s) or rolls itself back — even if
          this control node dies mid-update.
        </p>
        <table className="data mt-3">
          <thead>
            <tr>
              <th>Release</th>
              <th>SHA-256</th>
              <th>Config digest</th>
            </tr>
          </thead>
          <tbody>
            {releases.releases.map((r) => (
              <tr key={r.version}>
                <td className="mono">{r.version}</td>
                <td className="mono text-xs">{r.sha256.slice(0, 24)}…</td>
                <td className="mono text-xs">{r.configDigest ? r.configDigest.slice(0, 16) + "…" : "neutral"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="label mb-3">Audit log</div>
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {audit.audit
              .slice()
              .reverse()
              .slice(0, 60)
              .map((e, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap text-zinc-500">{ago(e.ts)}</td>
                  <td className="mono">{e.type}</td>
                  <td>{e.detail}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
