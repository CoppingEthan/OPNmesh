/**
 * What each site's router must do, as structured data. The UI renders it as
 * plain-language instructions (generic and UniFi-specific) and the UniFi
 * integration reconciles the same data onto a console.
 */
import type { RouterLayout, Snapshot } from "../model";
import { listenPortOf, meshSite, reachableSitesFrom, isReachable } from "../topology";

export interface RouterRoute {
  cidr: string;
  /** Human label, e.g. "Datacentre — Servers (VLAN 10)". */
  label: string;
  /** Stable name for objects OPNmesh creates on a router, e.g. "OPNmesh: dc servers". */
  objectName: string;
  /** False for the masquerade layout, where routes are optional. */
  required: boolean;
}

export interface RouterPlan {
  siteId: string;
  siteSlug: string;
  layout: RouterLayout;
  /** The gateway VM's address the router points routes at. */
  nextHop: string;
  routes: RouterRoute[];
  /** Present when the site accepts inbound tunnels. */
  portForward: { protocol: "udp"; port: number; toIp: string } | null;
  /** Same-LAN layout needs an allow-all-states policy for these destinations. */
  allStatesPolicy: { name: string; destinations: string[] } | null;
  /** Optional belt-and-braces rule blocking LAN → clients. */
  clientBlockPolicy: { name: string; destination: string };
  /** This site's own LANs and whether each is carried across the mesh. */
  localLans: Array<{ cidr: string; name: string; vlan: number | null; shared: boolean }>;
}

export function generateRouterPlan(snap: Snapshot, siteId: string): RouterPlan {
  const s = meshSite(snap, siteId);
  const required = s.routerLayout !== "masquerade";
  const routes: RouterRoute[] = [];

  for (const r of reachableSitesFrom(snap, s.id)) {
    for (const lan of r.lans) {
      if (!lan.shared) continue;
      const vlan = lan.vlan !== null ? ` (VLAN ${lan.vlan})` : "";
      routes.push({
        cidr: lan.cidr,
        label: `${r.name} — ${lan.name}${vlan}`,
        objectName: `OPNmesh: ${r.slug} ${lan.name}`.slice(0, 60),
        required,
      });
    }
  }
  routes.push(
    {
      cidr: snap.settings.gatewayCidr,
      label: "Mesh tunnel addresses (gateways)",
      objectName: "OPNmesh: tunnel addresses",
      required,
    },
    {
      cidr: snap.settings.clientCidr,
      label: "Roaming clients (aggregate only — never per-client routes)",
      objectName: "OPNmesh: roaming clients",
      required,
    },
  );

  const destinations = routes.map((r) => r.cidr);

  return {
    siteId: s.id,
    siteSlug: s.slug,
    layout: s.routerLayout,
    nextHop: s.gateway.lanIp,
    routes,
    portForward: isReachable(s)
      ? { protocol: "udp", port: listenPortOf(snap, s), toIp: s.gateway.lanIp }
      : null,
    allStatesPolicy:
      s.routerLayout === "same_lan"
        ? { name: "OPNmesh: allow all states to remote sites", destinations }
        : null,
    clientBlockPolicy: { name: "OPNmesh: block LAN to roaming clients", destination: snap.settings.clientCidr },
    localLans: s.lans.map((l) => ({ cidr: l.cidr, name: l.name, vlan: l.vlan, shared: l.shared })),
  };
}
