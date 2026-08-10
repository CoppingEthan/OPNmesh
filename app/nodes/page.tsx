import { revalidatePath } from "next/cache";
import { requireAdmin } from "../../lib/ui/auth.js";
import { loadSites, editSites } from "../../lib/ui/sites.js";
import { control } from "../../lib/ui/control.js";
import { HealthBadge, ago, healthOf } from "../ui.js";

export const dynamic = "force-dynamic";

async function renameNode(formData: FormData) {
  "use server";
  await requireAdmin();
  const id = String(formData.get("siteId"));
  const name = String(formData.get("name")).trim();
  await editSites(`ui: rename gateway of ${id} to "${name}"`, (doc) => {
    const site = doc.sites.find((s: any) => s.id === id);
    if (!site) throw new Error(`unknown site ${id}`);
    site.gateway.name = name || undefined;
  });
  revalidatePath("/nodes");
}

async function changePort(formData: FormData) {
  "use server";
  await requireAdmin();
  // Port changes are coordinated transactions handled by the control server
  // (§6) — never a plain config edit.
  await control.changePort(String(formData.get("siteId")), Number(formData.get("port")));
  revalidatePath("/nodes");
}

async function togglePin(formData: FormData) {
  "use server";
  await requireAdmin();
  await control.pin(String(formData.get("siteId")), formData.get("pinned") === "true");
  revalidatePath("/nodes");
}

async function issueToken(formData: FormData) {
  "use server";
  await requireAdmin();
  const res = await control.issueToken(
    String(formData.get("role") ?? "gateway"),
    String(formData.get("note") ?? ""),
  );
  const { redirect } = await import("next/navigation");
  redirect(`/nodes?token=${res.token}&sha=${res.installShSha256 ?? ""}`);
}

async function approveNode(formData: FormData) {
  "use server";
  await requireAdmin();
  const site = {
    id: String(formData.get("siteId")),
    name: String(formData.get("siteName")),
    lan: String(formData.get("lan")),
    gateway: {
      name: String(formData.get("gwName")) || undefined,
      lan_ip: String(formData.get("lanIp")),
      tunnel_ip: String(formData.get("tunnelIp")),
      endpoint: String(formData.get("endpoint")) || null,
      ...(formData.get("listenPort") ? { listen_port: Number(formData.get("listenPort")) } : {}),
    },
  };
  await control.approve(String(formData.get("pendingId")), site);
  revalidatePath("/nodes");
}

async function rejectNode(formData: FormData) {
  "use server";
  await requireAdmin();
  await control.reject(String(formData.get("pendingId")));
  revalidatePath("/nodes");
}

async function removeNode(formData: FormData) {
  "use server";
  await requireAdmin();
  await control.removeNode(String(formData.get("siteId")));
  revalidatePath("/nodes");
}

export default async function NodesPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; sha?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const sites = loadSites();
  const [state, pending, rollout] = await Promise.all([
    control.state().catch(() => ({ nodes: {} as Record<string, any> })),
    control.pending().catch(() => ({ pending: [] })),
    control.rollout().catch(() => ({ rollout: null, settings: { pinned: {} as Record<string, boolean>, frozen: false, updateWindow: "always" } })),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="h1">Nodes</h1>

      <div className="card">
        <div className="label mb-3">Gateways</div>
        <table className="data">
          <thead>
            <tr>
              <th>Node</th>
              <th>Status</th>
              <th>Display name</th>
              <th>WireGuard port</th>
              <th>Pin</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sites.cfg.sites.map((s) => {
              const n = (state.nodes as Record<string, any>)[s.id];
              const pinned = rollout.settings.pinned[s.id] === true;
              return (
                <tr key={s.id}>
                  <td>
                    <div className="mono">{s.id}</div>
                    <div className="text-xs text-zinc-500">seen {ago(n?.lastSeen ?? null)} · v{n?.version || "?"}</div>
                  </td>
                  <td>
                    <HealthBadge health={healthOf(n?.lastSeen ?? null, n?.lastError ?? "", n?.drift ?? false)} />
                  </td>
                  <td>
                    <form action={renameNode} className="flex gap-1">
                      <input type="hidden" name="siteId" value={s.id} />
                      <input className="input w-40" name="name" defaultValue={s.gateway.displayName ?? ""} placeholder="cosmetic name" />
                      <button className="btn" type="submit">Save</button>
                    </form>
                  </td>
                  <td>
                    <form action={changePort} className="flex gap-1">
                      <input type="hidden" name="siteId" value={s.id} />
                      <input className="input mono w-24" name="port" type="number" min={1} max={65535} defaultValue={s.gateway.listenPort} />
                      <button className="btn" type="submit" title="Coordinated across the whole mesh — a brief interruption on this node's tunnels">
                        Change
                      </button>
                    </form>
                    <div className="mt-1 text-xs text-zinc-500">changes are coordinated mesh-wide (§6)</div>
                  </td>
                  <td>
                    <form action={togglePin}>
                      <input type="hidden" name="siteId" value={s.id} />
                      <input type="hidden" name="pinned" value={pinned ? "false" : "true"} />
                      <button className={`btn ${pinned ? "btn-danger" : ""}`} type="submit">
                        {pinned ? "pinned" : "pin"}
                      </button>
                    </form>
                  </td>
                  <td>
                    <form action={removeNode}>
                      <input type="hidden" name="siteId" value={s.id} />
                      <button className="btn btn-danger" type="submit">Remove</button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="label mb-3">Add node</div>
        <form action={issueToken} className="flex items-end gap-2">
          <div>
            <div className="label">Role</div>
            <select className="input" name="role" defaultValue="gateway">
              <option value="gateway">gateway</option>
              <option value="relay">relay</option>
            </select>
          </div>
          <div className="flex-1">
            <div className="label">Note</div>
            <input className="input" name="note" placeholder="e.g. site-d gateway" />
          </div>
          <button className="btn btn-primary" type="submit">Issue one-time token</button>
        </form>
        <p className="mt-2 text-xs text-zinc-500">
          Tokens are single-use, expire in 15 minutes, and are bound to the role. Run the printed
          install command on the new node; it appears below as pending. Nothing gets configuration
          until you approve it.
        </p>
        {params.token && (
          <div className="mt-3 rounded border border-emerald-900 bg-black/40 p-3">
            <div className="label mb-1 text-emerald-400">One-time enrolment command (shown once)</div>
            <pre className="conf">{`curl -fsSL https://<control-host>:<port>/install.sh | sudo bash -s -- \\
  --token ${params.token} \\
  --server https://<control-host>:<port>`}</pre>
            {params.sha && (
              <p className="mono mt-2 text-xs text-zinc-500">
                install.sh SHA-256: {params.sha} — verify before piping to a shell:
                {" curl -fsSL …/install.sh | sha256sum"}
              </p>
            )}
          </div>
        )}
      </div>

      {pending.pending.length > 0 && (
        <div className="card border-amber-900">
          <div className="label mb-3 text-amber-400">Pending approval</div>
          {pending.pending.map((p) => (
            <div key={p.id} className="mb-4 rounded border border-zinc-800 p-3">
              <div className="mono text-sm">
                {p.hostname} · {p.role} · fingerprint <span className="text-amber-300">{p.fingerprint}</span>
              </div>
              <div className="mono mt-1 text-xs text-zinc-500">
                key {p.publicKey} · addresses {p.addresses.join(", ") || "none reported"} · enrolled {ago(p.enrolledAt)}
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Verify the fingerprint out-of-band against the node's install output before approving.
              </p>
              <form action={approveNode} className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                <input type="hidden" name="pendingId" value={p.id} />
                <input className="input mono" name="siteId" placeholder="site id (e.g. site-d)" required />
                <input className="input" name="siteName" placeholder="Site name" required />
                <input className="input mono" name="lan" placeholder="LAN CIDR 10.40.0.0/16" required />
                <input className="input mono" name="lanIp" placeholder="gateway LAN IP" required />
                <input className="input mono" name="tunnelIp" placeholder="tunnel IP 10.99.0.x" required />
                <input className="input mono" name="endpoint" placeholder="endpoint (empty = NAT)" />
                <input className="input mono" name="listenPort" type="number" placeholder="listen port (default)" />
                <input className="input" name="gwName" placeholder="display name" />
                <div className="col-span-2 flex gap-2 md:col-span-4">
                  <button className="btn btn-primary" type="submit">Approve</button>
                </div>
              </form>
              <form action={rejectNode} className="mt-2">
                <input type="hidden" name="pendingId" value={p.id} />
                <button className="btn btn-danger" type="submit">Reject</button>
              </form>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

