import { revalidatePath } from "next/cache";
import { existsSync } from "node:fs";
import { simpleGit } from "simple-git";
import { requireAdmin, logout } from "../../lib/ui/auth.js";
import { loadSites, editSites } from "../../lib/ui/sites.js";
import { STATE_DIR, CONTROL_URL } from "../../lib/ui/env.js";

export const dynamic = "force-dynamic";

async function setRetention(formData: FormData) {
  "use server";
  await requireAdmin();
  const days = Number(formData.get("days"));
  await editSites(`ui: flow retention → ${days} days`, (doc) => {
    doc.network ??= {};
    doc.network.flow_retention_days = days;
  });
  revalidatePath("/settings");
}

async function addRemote(formData: FormData) {
  "use server";
  await requireAdmin();
  const url = String(formData.get("url")).trim();
  if (!url) return;
  const git = simpleGit(STATE_DIR);
  await git.addRemote("origin", url).catch(async () => {
    await git.remote(["set-url", "origin", url]);
  });
  revalidatePath("/settings");
}

async function removeRemote() {
  "use server";
  await requireAdmin();
  await simpleGit(STATE_DIR).removeRemote("origin").catch(() => {});
  revalidatePath("/settings");
}

async function doLogout() {
  "use server";
  await logout();
  const { redirect } = await import("next/navigation");
  redirect("/login");
}

export default async function SettingsPage() {
  await requireAdmin();
  const sites = loadSites();
  let remote: string | null = null;
  if (existsSync(`${STATE_DIR}/.git`)) {
    const remotes = await simpleGit(STATE_DIR).getRemotes(true).catch(() => []);
    remote = remotes.find((r) => r.name === "origin")?.refs.push ?? null;
  }

  const ports = [
    ["Web / API", process.env["OPNMESH_WEB_PORT"] ?? "3000 (dev)"],
    ["Control (agent API)", CONTROL_URL],
    ["Prometheus", process.env["OPNMESH_PROM_URL"] ?? "http://localhost:19090"],
    ["Alertmanager", process.env["OPNMESH_AM_URL"] ?? "http://localhost:19093"],
    ["Grafana", process.env["OPNMESH_GRAFANA_URL"] ?? "http://localhost:13000"],
  ] as const;

  return (
    <div className="space-y-6">
      <h1 className="h1">Settings</h1>

      <div className="card">
        <div className="label mb-3">Service endpoints (all configurable via environment — nothing hardcoded)</div>
        <table className="data">
          <tbody>
            {ports.map(([name, value]) => (
              <tr key={name}>
                <td>{name}</td>
                <td className="mono">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="label mb-2">Flow record retention</div>
        <form action={setRetention} className="flex items-center gap-2">
          <input
            className="input mono w-24"
            name="days"
            type="number"
            min={1}
            max={365}
            defaultValue={sites.cfg.network.flowRetentionDays}
          />
          <span className="text-sm text-zinc-400">days</span>
          <button className="btn" type="submit">Save</button>
        </form>
      </div>

      <div className="card border-amber-900">
        <div className="label mb-2 text-amber-400">Config repository remote (off by default)</div>
        <p className="mb-3 text-sm text-zinc-400">
          The config repository is local history only — nothing is ever pushed automatically.
          sites.yml describes your entire network topology: if you add a remote for off-box backup,
          it must be a <span className="font-semibold text-amber-300">private</span> repository.
        </p>
        {remote ? (
          <div className="flex items-center gap-2">
            <span className="mono text-sm">{remote}</span>
            <form action={removeRemote}>
              <button className="btn btn-danger" type="submit">Remove remote</button>
            </form>
          </div>
        ) : (
          <form action={addRemote} className="flex gap-2">
            <input className="input mono" name="url" placeholder="git@private-host:you/mesh-config.git" />
            <button className="btn" type="submit">Add remote (no auto-push)</button>
          </form>
        )}
      </div>

      <div className="card">
        <div className="label mb-2">Session</div>
        <form action={doLogout}>
          <button className="btn" type="submit">Sign out</button>
        </form>
      </div>
    </div>
  );
}
