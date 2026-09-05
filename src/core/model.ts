/**
 * The snapshot: everything the generators need, read from the database in one
 * transaction. Plain data, no methods, no database types. Every generator,
 * validator and topology function is a pure function of a Snapshot, which is
 * what makes them trivially testable and deterministic.
 */

export type RouterLayout = "transit" | "same_lan" | "masquerade";

export interface NetworkSettings {
  name: string;
  /** Tunnel addresses for gateways, e.g. 10.99.0.0/24. */
  gatewayCidr: string;
  /** Tunnel addresses for roaming clients, e.g. 10.99.1.0/24. */
  clientCidr: string;
  /** Default WireGuard listen port; a gateway may override. */
  listenPort: number;
  mtu: number;
  keepalive: number;
  /** Kernel interface name on gateways, e.g. opnmesh0. */
  interfaceName: string;
  /** Root-only file on each gateway holding its private key. */
  privateKeyPath: string;
}

export interface LanSnapshot {
  id: string;
  cidr: string;
  name: string;
  vlan: number | null;
  /** Shared LANs are reachable from the mesh; unshared ones stay local. */
  shared: boolean;
}

export interface GatewaySnapshot {
  id: string;
  publicKey: string;
  /** Address inside gatewayCidr. */
  tunnelIp: string;
  /** Address on the site network the router points its static routes at. */
  lanIp: string;
  /** Public IP or DDNS hostname; null when the site cannot accept inbound UDP. */
  endpointHost: string | null;
  /** Overrides settings.listenPort when set. */
  listenPort: number | null;
  /** Overrides settings.mtu when set. */
  mtu: number | null;
}

export interface SiteSnapshot {
  id: string;
  name: string;
  /** Stable identifier used in generated files and firewall object names. */
  slug: string;
  routerLayout: RouterLayout;
  /** Lower is preferred when a hub must be chosen. */
  hubPriority: number;
  dnsServer: string | null;
  dnsDomain: string | null;
  lans: LanSnapshot[];
  /** Null until a gateway has enrolled and been approved for this site. */
  gateway: GatewaySnapshot | null;
}

export interface ClientSnapshot {
  id: string;
  name: string;
  slug: string;
  tunnelIp: string;
  publicKey: string;
  enabled: boolean;
  /** Which reachable site relays traffic to outbound-only sites for this client. */
  preferredSiteId: string | null;
  /** Null = every site. */
  allowedSiteIds: string[] | null;
  /** Let hosts at sites open connections to this client. */
  allowInbound: boolean;
}

export interface Snapshot {
  settings: NetworkSettings;
  sites: SiteSnapshot[];
  clients: ClientSnapshot[];
}

export const DEFAULT_SETTINGS: NetworkSettings = {
  name: "OPNmesh",
  gatewayCidr: "10.99.0.0/24",
  clientCidr: "10.99.1.0/24",
  listenPort: 51820,
  mtu: 1420,
  keepalive: 25,
  interfaceName: "opnmesh0",
  privateKeyPath: "/etc/opnmesh/private.key",
};

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/** Turn a human name into a slug; the caller ensures uniqueness. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31)
    .replace(/-+$/g, "");
  return s.length > 0 && /^[a-z0-9]/.test(s) ? s : `x${s}`.slice(0, 31);
}
