/**
 * Copy-pasteable per-site router instructions (the routes page).
 *
 * OPNmesh never manages site routers — a human applies these. Every port in
 * the text is the actual configured one, never a literal default.
 *
 * Multi-VLAN sites: one static route per remote subnet, and an explicit note
 * about which local VLANs are (and are not) carried across the mesh.
 *
 * On client reachability vs isolation (§9): the router carries the client
 * subnet as one aggregate route so that replies from LAN hosts can flow back
 * through the gateway, where conntrack drops anything that is not a reply.
 * Individual client /32 routes are never emitted anywhere. The LAN-IN drop
 * rule below is defense in depth on top of the gateway's enforcement.
 */
import type { ResolvedConfig } from "../schema.js";
import { pairStatus } from "../topology.js";

export function generateRouterInstructions(cfg: ResolvedConfig, siteId: string): string {
  const s = cfg.sites.find((x) => x.id === siteId);
  if (!s) throw new Error(`unknown site "${siteId}"`);
  const gw = s.gateway.lanIp;

  const reachable = cfg.sites.filter(
    (r) => r.id !== s.id && pairStatus(cfg, s.id, r.id).kind !== "unreachable",
  );

  const lines: string[] = [
    `# Router instructions for site "${s.id}" (${s.name})`,
    `# Next hop for all mesh routes: the OPNmesh gateway at ${gw}`,
    "",
    "## Static routes",
  ];

  for (const r of reachable) {
    for (const lan of r.lans) {
      if (lan.role === "guest") continue;
      const label = [r.id, lan.name, lan.vlan ? `vlan ${lan.vlan}` : null]
        .filter(Boolean)
        .join(" ");
      lines.push(`${lan.cidr} via ${gw}    # ${label}`);
    }
  }
  lines.push(
    `${cfg.network.gatewaySubnet} via ${gw}    # mesh tunnel addresses`,
    `${cfg.network.clientSubnet} via ${gw}    # roaming clients (aggregate only — never per-client routes)`,
  );

  lines.push("", "## This site's networks");
  for (const lan of s.lans) {
    const label = [lan.name, lan.vlan ? `vlan ${lan.vlan}` : null].filter(Boolean).join(", ");
    const suffix =
      lan.role === "guest"
        ? "NOT carried across the mesh (guest) — stays local to this site"
        : lan.role === "management"
          ? "carried across the mesh, restricted to admin sources by the gateway firewall"
          : "carried across the mesh";
    lines.push(`${lan.cidr}${label ? `  (${label})` : ""} — ${suffix}`);
  }

  lines.push(
    "",
    "## Firewall",
    "# Block LAN hosts from opening connections to roaming clients (defense in",
    "# depth — the gateway already enforces this with conntrack):",
    `LAN-IN: drop NEW connections from any local network to ${cfg.network.clientSubnet}`,
  );

  const guests = s.lans.filter((l) => l.role === "guest");
  if (guests.length > 0) {
    lines.push(
      "# Guest networks must not reach the mesh at all:",
      ...guests.map(
        (l) =>
          `LAN-IN: drop connections from ${l.cidr} to ${cfg.network.gatewaySubnet} and all remote site subnets`,
      ),
    );
  }

  if (s.gateway.endpoint !== null) {
    lines.push(
      "",
      "## WAN",
      `Forward UDP port ${s.gateway.listenPort} to ${gw} (WireGuard on this gateway).`,
    );
  }

  lines.push(
    "",
    "## Note for UniFi gateways",
    "A static route alone is NOT enough on UniFi: traffic is silently dropped",
    "unless a matching LAN-IN firewall rule allows the routed subnets.",
  );

  return lines.join("\n") + "\n";
}
