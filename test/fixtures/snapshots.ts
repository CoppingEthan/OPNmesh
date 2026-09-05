/**
 * Reference scenarios for generator, validator and golden tests. Public keys
 * are deterministic fakes (sha256 of a seed, base64 → 44 chars) so goldens are
 * stable; nothing here is a real key.
 */
import { createHash } from "node:crypto";
import type { ClientSnapshot, LanSnapshot, SiteSnapshot, Snapshot } from "@/core/model";
import { DEFAULT_SETTINGS } from "@/core/model";

export function fakeKey(seed: string): string {
  return createHash("sha256").update(`opnmesh-test-${seed}`).digest("base64");
}

let lanCounter = 0;
export function lan(cidr: string, name: string, opts: Partial<LanSnapshot> = {}): LanSnapshot {
  lanCounter += 1;
  return { id: `lan-${lanCounter}`, cidr, name, vlan: null, shared: true, ...opts };
}

export function site(
  slug: string,
  opts: {
    name?: string;
    lans: LanSnapshot[];
    tunnelIp: string;
    lanIp: string;
    endpoint?: string | null;
    layout?: SiteSnapshot["routerLayout"];
    hubPriority?: number;
    listenPort?: number | null;
    dnsServer?: string | null;
    dnsDomain?: string | null;
    noGateway?: boolean;
  },
): SiteSnapshot {
  return {
    id: `site-${slug}`,
    name: opts.name ?? slug.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
    slug,
    routerLayout: opts.layout ?? "transit",
    hubPriority: opts.hubPriority ?? 100,
    dnsServer: opts.dnsServer ?? null,
    dnsDomain: opts.dnsDomain ?? null,
    lans: opts.lans,
    gateway: opts.noGateway
      ? null
      : {
          id: `gw-${slug}`,
          publicKey: fakeKey(`gw-${slug}`),
          tunnelIp: opts.tunnelIp,
          lanIp: opts.lanIp,
          endpointHost: opts.endpoint === undefined ? `${slug}.example.com` : opts.endpoint,
          listenPort: opts.listenPort ?? null,
          mtu: null,
        },
  };
}

export function client(
  slug: string,
  tunnelIp: string,
  opts: Partial<Pick<ClientSnapshot, "enabled" | "preferredSiteId" | "allowedSiteIds" | "allowInbound" | "name">> = {},
): ClientSnapshot {
  return {
    id: `client-${slug}`,
    name: opts.name ?? slug,
    slug,
    tunnelIp,
    publicKey: fakeKey(`client-${slug}`),
    enabled: opts.enabled ?? true,
    preferredSiteId: opts.preferredSiteId ?? null,
    allowedSiteIds: opts.allowedSiteIds ?? null,
    allowInbound: opts.allowInbound ?? false,
  };
}

export function snapshot(sites: SiteSnapshot[], clients: ClientSnapshot[] = [], settings = {}): Snapshot {
  return { settings: { ...DEFAULT_SETTINGS, ...settings }, sites, clients };
}

// ---------------------------------------------------------------------------

export const scenarios: Record<string, () => Snapshot> = {
  /** One site, nothing to peer with. */
  "single-site": () =>
    snapshot([site("dc", { lans: [lan("10.0.1.0/24", "Servers")], tunnelIp: "10.99.0.1", lanIp: "10.0.250.2", hubPriority: 1 })]),

  /** Two reachable sites, one client. The reference shape. */
  "two-sites": () =>
    snapshot(
      [
        site("dc", {
          name: "Datacentre",
          lans: [lan("10.0.1.0/24", "Servers", { vlan: 10 }), lan("10.0.99.0/24", "Management", { vlan: 99 })],
          tunnelIp: "10.99.0.1",
          lanIp: "10.0.250.2",
          hubPriority: 1,
          dnsServer: "10.0.1.53",
          dnsDomain: "corp.example",
        }),
        site("office", {
          name: "Office",
          lans: [lan("192.168.20.0/24", "Staff", { vlan: 20 }), lan("192.168.30.0/24", "Voice", { vlan: 30 })],
          tunnelIp: "10.99.0.2",
          lanIp: "192.168.250.2",
          hubPriority: 2,
          endpoint: "203.0.113.20",
        }),
      ],
      [client("alice-laptop", "10.99.1.10", { name: "Alice's laptop" })],
    ),

  /** Datacentre + office reachable; warehouse behind CGNAT (outbound-only). */
  "hub-and-spoke": () =>
    snapshot(
      [
        site("dc", { lans: [lan("10.0.1.0/24", "Servers")], tunnelIp: "10.99.0.1", lanIp: "10.0.250.2", hubPriority: 1 }),
        site("office", {
          lans: [lan("192.168.20.0/24", "Staff")],
          tunnelIp: "10.99.0.2",
          lanIp: "192.168.20.2",
          layout: "same_lan",
          hubPriority: 2,
          endpoint: "203.0.113.20",
        }),
        site("warehouse", {
          lans: [lan("10.30.0.0/24", "Warehouse")],
          tunnelIp: "10.99.0.3",
          lanIp: "10.30.0.2",
          layout: "masquerade",
          endpoint: null,
        }),
      ],
      [client("alice-laptop", "10.99.1.10"), client("bob-phone", "10.99.1.11", { preferredSiteId: "site-office" })],
    ),

  /** Two outbound-only sites must transit the hub. */
  "two-spokes": () =>
    snapshot(
      [
        site("dc", { lans: [lan("10.0.1.0/24", "Servers")], tunnelIp: "10.99.0.1", lanIp: "10.0.250.2", hubPriority: 1 }),
        site("office", { lans: [lan("192.168.20.0/24", "Staff")], tunnelIp: "10.99.0.2", lanIp: "192.168.250.2", hubPriority: 2 }),
        site("shop-north", { lans: [lan("10.31.0.0/24", "Shop")], tunnelIp: "10.99.0.3", lanIp: "10.31.0.2", endpoint: null }),
        site("shop-south", { lans: [lan("10.32.0.0/24", "Shop")], tunnelIp: "10.99.0.4", lanIp: "10.32.0.2", endpoint: null }),
      ],
      [client("alice-laptop", "10.99.1.10")],
    ),

  /** A site with an unshared LAN and a client restricted to one site, plus an inbound-allowed client. */
  "policies": () =>
    snapshot(
      [
        site("dc", {
          lans: [lan("10.0.1.0/24", "Servers"), lan("10.0.200.0/24", "Lab", { shared: false })],
          tunnelIp: "10.99.0.1",
          lanIp: "10.0.250.2",
          hubPriority: 1,
        }),
        site("office", { lans: [lan("192.168.20.0/24", "Staff")], tunnelIp: "10.99.0.2", lanIp: "192.168.250.2", hubPriority: 2 }),
        site("depot", { lans: [lan("10.40.0.0/24", "Depot")], tunnelIp: "10.99.0.3", lanIp: "10.40.0.2", endpoint: null }),
      ],
      [
        client("contractor", "10.99.1.20", { allowedSiteIds: ["site-office"] }),
        client("depot-tablet", "10.99.1.21", { allowedSiteIds: ["site-depot"] }),
        client("support-pc", "10.99.1.22", { allowInbound: true }),
        client("old-laptop", "10.99.1.23", { enabled: false }),
      ],
    ),

  /** Only outbound-only sites: nothing can connect. */
  "no-hub": () =>
    snapshot([
      site("a", { lans: [lan("10.1.0.0/24", "A")], tunnelIp: "10.99.0.1", lanIp: "10.1.0.2", endpoint: null }),
      site("b", { lans: [lan("10.2.0.0/24", "B")], tunnelIp: "10.99.0.2", lanIp: "10.2.0.2", endpoint: null }),
    ]),

  /** A site without a gateway yet is ignored by the generators. */
  "pending-site": () =>
    snapshot([
      site("dc", { lans: [lan("10.0.1.0/24", "Servers")], tunnelIp: "10.99.0.1", lanIp: "10.0.250.2", hubPriority: 1 }),
      site("new-office", { lans: [lan("10.50.0.0/24", "Staff")], tunnelIp: "10.99.0.9", lanIp: "10.50.0.2", noGateway: true }),
    ]),
};
