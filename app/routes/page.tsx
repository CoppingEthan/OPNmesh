import { requireAdmin } from "../../lib/ui/auth.js";
import { loadSites } from "../../lib/ui/sites.js";

export const dynamic = "force-dynamic";

export default async function RoutesPage() {
  await requireAdmin();
  const sites = loadSites();

  return (
    <div className="space-y-6">
      <h1 className="h1">Site router instructions</h1>
      <p className="text-sm text-zinc-400">
        OPNmesh never configures site routers. Copy these into each router by hand — every port and
        address below comes from the actual configuration. UniFi note: a static route alone is
        silently dropped unless a matching LAN-IN firewall rule allows the routed subnets.
      </p>
      {sites.cfg.sites.map((s) => (
        <div key={s.id} className="card">
          <div className="label mb-2">
            {s.id} ({s.name})
          </div>
          <pre className="conf">{sites.bundle.routers[s.id]}</pre>
        </div>
      ))}
    </div>
  );
}
