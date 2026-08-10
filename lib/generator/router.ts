/**
 * Copy-pasteable per-site router instructions (the routes page).
 *
 * OPNmesh never manages site routers — a human applies these. Every port in
 * the text is the actual configured one, never a literal default.
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
    `# Next hop for all mesh routes: the WireGuard gateway at ${gw}`,
    "",
    "## Static routes",
    ...reachable.map((r) => `${r.lan} via ${gw}    # ${r.id} LAN`),
    `${cfg.network.gatewaySubnet} via ${gw}    # mesh tunnel addresses`,
    `${cfg.network.clientSubnet} via ${gw}    # roaming clients (aggregate only — never per-client routes)`,
    "",
    "## Firewall",
    `# Block LAN hosts from opening connections to roaming clients (defense in`,
    `# depth — the gateway already enforces this with conntrack):`,
    `LAN-IN: drop NEW connections from ${s.lan} to ${cfg.network.clientSubnet}`,
  ];

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
