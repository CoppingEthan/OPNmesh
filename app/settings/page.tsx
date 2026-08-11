import { revalidatePath } from "next/cache";
import { existsSync } from "node:fs";
import { simpleGit } from "simple-git";
import {
  requireAdmin,
  logout,
  setAdminPassword,
  passwordProblem,
  verifyAdminPassword,
} from "../../lib/ui/auth.js";
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

/**
 * Only https:// and scp-style git@host:path are accepted. Git supports
 * transports such as `ext::sh -c ...` that execute commands on fetch/push —
 * an operator-supplied remote must never be able to reach those.
 */
function safeRemote(url: string): boolean {
  if (url.length > 300) return false;
  if (/^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/.test(url)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._~/-]+$/.test(url)) return true;
  return false;
}

async function addRemote(formData: FormData) {
  "use server";
  await requireAdmin();
  const url = String(formData.get("url")).trim();
  if (!url) return;
  if (!safeRemote(url)) {
    const { redirect } = await import("next/navigation");
    redirect("/settings?err=" + encodeURIComponent("Use an https:// URL or git@host:path address."));
  }
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

async function changePassword(formData: FormData) {
  "use server";
  await requireAdmin();
  const current = String(formData.get("current") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const { redirect } = await import("next/navigation");
  // Require the CURRENT password. Without it, any momentarily-open session (a
  // walk-up to an unlocked browser) could set a new password known only to the
  // attacker — which also wipes every session, evicting the real operator with
  // no recovery path since /setup is closed once an admin exists.
  if (!(await verifyAdminPassword(current))) {
    redirect("/settings?err=" + encodeURIComponent("Your current password is not correct."));
  }
  if (password !== confirm) redirect("/settings?err=" + encodeURIComponent("Passwords do not match."));
  const problem = passwordProblem(password);
  if (problem) redirect("/settings?err=" + encodeURIComponent(problem));
  // Signs every session out, including this one — a password change must not
  // leave a stolen session alive.
  await setAdminPassword(password);
  redirect("/login");
}

async function doLogout() {
  "use server";
  await logout();
  const { redirect } = await import("next/navigation");
  redirect("/login");
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
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
      {params.err && <p className="status-bad text-sm">{params.err}</p>}

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
        <div className="label mb-2">Change password</div>
        <p className="mb-2 text-sm text-zinc-400">
          Changing your password signs out every device, including this one.
        </p>
        <form action={changePassword} className="flex flex-wrap items-end gap-2">
          <input className="input w-56" type="password" name="current" placeholder="Current password" autoComplete="current-password" />
          <input className="input w-56" type="password" name="password" placeholder="New password" autoComplete="new-password" />
          <input className="input w-56" type="password" name="confirm" placeholder="Repeat it" autoComplete="new-password" />
          <button className="btn" type="submit">Change password</button>
        </form>
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
