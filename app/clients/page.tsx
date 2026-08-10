import { revalidatePath } from "next/cache";
import QRCode from "qrcode";
import { requireAdmin } from "../../lib/ui/auth.js";
import { loadSites, editSites } from "../../lib/ui/sites.js";
import { CLIENT_PRIVATE_KEY_PLACEHOLDER } from "../../lib/generator/wireguard.js";

export const dynamic = "force-dynamic";

async function setEntryPoints(formData: FormData) {
  "use server";
  await requireAdmin();
  const clientId = String(formData.get("clientId"));
  const entries = String(formData.get("entries"))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await editSites(`ui: client ${clientId} entry points → [${entries.join(", ")}]`, (doc) => {
    const c = doc.clients.find((x: any) => x.id === clientId);
    if (!c) throw new Error(`unknown client ${clientId}`);
    if (entries.length === 0) delete c.entry_points;
    else c.entry_points = entries;
  });
  revalidatePath("/clients");
}

async function setHomeSite(formData: FormData) {
  "use server";
  await requireAdmin();
  const clientId = String(formData.get("clientId"));
  const homeSite = String(formData.get("homeSite"));
  await editSites(`ui: client ${clientId} home site → ${homeSite}`, (doc) => {
    const c = doc.clients.find((x: any) => x.id === clientId);
    if (!c) throw new Error(`unknown client ${clientId}`);
    c.home_site = homeSite;
  });
  revalidatePath("/clients");
}

export default async function ClientsPage() {
  await requireAdmin();
  const sites = loadSites();
  const eligible = sites.cfg.sites.filter((s) => s.gateway.endpoint !== null).map((s) => s.id);

  const qrByClient: Record<string, string> = {};
  for (const c of sites.cfg.clients) {
    // The QR carries the config with the private-key placeholder — the key is
    // generated on the device and never known to the control node.
    qrByClient[c.id] = await QRCode.toDataURL(sites.bundle.clients[c.id]!.config, {
      margin: 1,
      width: 220,
      color: { dark: "#e4e4e7", light: "#09090b" },
    });
  }

  return (
    <div className="space-y-6">
      <h1 className="h1">Clients</h1>
      <p className="text-sm text-zinc-400">
        Entry point ≠ reach: a client entering at one site reaches every other site's resources over
        the existing tunnels. Entry points only decide which gateways the client dials.
      </p>

      {sites.cfg.clients.map((c) => (
        <div key={c.id} className="card">
          <div className="flex items-baseline justify-between">
            <div>
              <span className="font-medium text-zinc-100">{c.displayName ?? c.id}</span>{" "}
              <span className="mono text-xs text-zinc-500">
                {c.id} · {c.tunnelIp}
              </span>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-3">
            <div>
              <div className="label mb-2">Entry points (preference order)</div>
              <div className="space-y-1 text-sm">
                {sites.cfg.sites.map((s) => {
                  const ok = eligible.includes(s.id);
                  const idx = c.entryPoints.indexOf(s.id);
                  return (
                    <div key={s.id} className={ok ? "" : "opacity-50"}>
                      <span className="mono">{s.id}</span>{" "}
                      {idx >= 0 && <span className="status-ok">#{idx + 1}</span>}
                      {!ok && (
                        <span className="ml-1 text-xs text-zinc-500">
                          — no inbound UDP port; clients cannot enter here. Open its configured port
                          and add DDNS if the WAN is dynamic.
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <form action={setEntryPoints} className="mt-2 flex gap-1">
                <input type="hidden" name="clientId" value={c.id} />
                <input
                  className="input mono"
                  name="entries"
                  defaultValue={c.entryPoints.join(", ")}
                  placeholder="site-a, site-b (empty = all eligible)"
                />
                <button className="btn" type="submit">Save</button>
              </form>
              <p className="mt-1 text-xs text-zinc-500">
                A single entry point loses everything when that gateway reboots — keep at least two.
              </p>
            </div>

            <div>
              <div className="label mb-2">Home site (cosmetic + DNS only)</div>
              <form action={setHomeSite} className="flex gap-1">
                <input type="hidden" name="clientId" value={c.id} />
                <select className="input" name="homeSite" defaultValue={c.homeSite}>
                  {sites.cfg.sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                    </option>
                  ))}
                </select>
                <button className="btn" type="submit">Save</button>
              </form>
              <div className="label mb-2 mt-6">Config</div>
              <pre className="conf max-h-64 overflow-y-auto">{sites.bundle.clients[c.id]!.config}</pre>
              <p className="mt-1 text-xs text-zinc-500">
                Replace {CLIENT_PRIVATE_KEY_PLACEHOLDER} on the device — private keys are generated
                there and never touch this panel.
              </p>
            </div>

            <div>
              <div className="label mb-2">QR (WireGuard app import)</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrByClient[c.id]!} alt={`config QR for ${c.id}`} className="rounded border border-zinc-800" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
