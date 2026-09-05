/**
 * Topology engine: which gateways peer directly, who relays for whom, how
 * roaming clients enter, and what breaks when a site dies.
 *
 * Everything here is a deterministic function of the snapshot, because
 * WireGuard's AllowedIPs is both route and filter and a prefix may live on
 * exactly one peer per interface. Both ends of every path must compute the
 * same answer independently; they can, because they compute it from the same
 * data with the same code.
 *
 * Rules:
 *  - A site takes part in the mesh once it has an approved gateway.
 *  - A gateway with an endpoint is "reachable"; one without is "outbound-only".
 *  - Any pair with at least one reachable side peers directly.
 *  - Two outbound-only sites transit the first hub (reachable sites ordered
 *    by hubPriority, then slug).
 *  - A client peers with every reachable site that carries something for it;
 *    outbound-only sites are reached through the client's relay site (its
 *    preferred site if reachable, else the first hub).
 */
import type { ClientSnapshot, GatewaySnapshot, SiteSnapshot, Snapshot } from "./model";
import { compareIp } from "./ip";

export interface MeshSite extends SiteSnapshot {
  gateway: GatewaySnapshot;
}

/** Sites with an approved gateway, in hub-priority order. */
export function meshSites(snap: Snapshot): MeshSite[] {
  return snap.sites
    .filter((s): s is MeshSite => s.gateway !== null)
    .sort((a, b) => a.hubPriority - b.hubPriority || a.slug.localeCompare(b.slug));
}

export function meshSite(snap: Snapshot, id: string): MeshSite {
  const s = meshSites(snap).find((x) => x.id === id);
  if (!s) throw new Error(`site "${id}" is not part of the mesh`);
  return s;
}

export function isReachable(site: MeshSite): boolean {
  return site.gateway.endpointHost !== null;
}

/** Reachable sites in priority order; the first is the default hub. */
export function hubs(snap: Snapshot): MeshSite[] {
  return meshSites(snap).filter(isReachable);
}

export function sharedCidrs(site: SiteSnapshot): string[] {
  return site.lans.filter((l) => l.shared).map((l) => l.cidr);
}

export function listenPortOf(snap: Snapshot, site: MeshSite): number {
  return site.gateway.listenPort ?? snap.settings.listenPort;
}

export function mtuOf(snap: Snapshot, site: MeshSite): number {
  return site.gateway.mtu ?? snap.settings.mtu;
}

export function endpointOf(snap: Snapshot, site: MeshSite): string | null {
  if (site.gateway.endpointHost === null) return null;
  return `${site.gateway.endpointHost}:${listenPortOf(snap, site)}`;
}

export type PairStatus =
  | { kind: "direct" }
  | { kind: "transit"; via: string }
  | { kind: "unreachable" };

export function pairStatus(snap: Snapshot, aId: string, bId: string): PairStatus {
  const a = meshSite(snap, aId);
  const b = meshSite(snap, bId);
  if (isReachable(a) || isReachable(b)) return { kind: "direct" };
  const hub = hubs(snap)[0];
  return hub ? { kind: "transit", via: hub.id } : { kind: "unreachable" };
}

export function arePeered(snap: Snapshot, aId: string, bId: string): boolean {
  return aId !== bId && pairStatus(snap, aId, bId).kind === "direct";
}

/** Next hop from `from` toward `to`: `to` when peered, else the hub, else null. */
export function nextHop(snap: Snapshot, from: string, to: string): string | null {
  const st = pairStatus(snap, from, to);
  if (st.kind === "direct") return to;
  if (st.kind === "transit") return st.via;
  return null;
}

/** Sites whose traffic `via` carries on behalf of `from` (transit only). */
export function transitDestinationsVia(snap: Snapshot, from: string, via: string): MeshSite[] {
  return meshSites(snap).filter((t) => t.id !== from && t.id !== via && nextHop(snap, from, t.id) === via);
}

export interface MatrixEntry {
  a: string;
  b: string;
  status: PairStatus;
}

/** Every unordered pair of mesh sites, in stable order. */
export function connectivityMatrix(snap: Snapshot): MatrixEntry[] {
  const sites = meshSites(snap);
  const out: MatrixEntry[] = [];
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i]!;
      const b = sites[j]!;
      out.push({ a: a.id, b: b.id, status: pairStatus(snap, a.id, b.id) });
    }
  }
  return out;
}

/** Unordered site pairs whose traffic transits `hubId`. */
export function relayedPairs(snap: Snapshot, hubId: string): Array<[MeshSite, MeshSite]> {
  const byId = new Map(meshSites(snap).map((s) => [s.id, s]));
  return connectivityMatrix(snap)
    .filter((e) => e.status.kind === "transit" && e.status.via === hubId)
    .map((e) => [byId.get(e.a)!, byId.get(e.b)!]);
}

/** Sites reachable from `siteId` by any path (direct or transit). */
export function reachableSitesFrom(snap: Snapshot, siteId: string): MeshSite[] {
  return meshSites(snap).filter((s) => s.id !== siteId && pairStatus(snap, siteId, s.id).kind !== "unreachable");
}

// ---------------------------------------------------------------------------
// Clients

export function activeClients(snap: Snapshot): ClientSnapshot[] {
  return snap.clients.filter((c) => c.enabled).sort((a, b) => compareIp(a.tunnelIp, b.tunnelIp));
}

export function clientAllows(client: ClientSnapshot, siteId: string): boolean {
  return client.allowedSiteIds === null || client.allowedSiteIds.includes(siteId);
}

/**
 * The reachable site that relays this client's traffic to outbound-only
 * sites: its preferred site when that site is reachable, else the first hub.
 */
export function clientRelaySite(snap: Snapshot, client: ClientSnapshot): MeshSite | null {
  const h = hubs(snap);
  if (client.preferredSiteId !== null) {
    const pref = h.find((s) => s.id === client.preferredSiteId);
    if (pref) return pref;
  }
  return h[0] ?? null;
}

/**
 * Sites whose subnets the client reaches through peer `entry`: the entry
 * itself when allowed, plus every allowed outbound-only site the entry
 * relays for this client.
 */
export function clientCarriedByEntry(snap: Snapshot, client: ClientSnapshot, entry: MeshSite): MeshSite[] {
  if (!isReachable(entry)) return [];
  const out: MeshSite[] = [];
  if (clientAllows(client, entry.id)) out.push(entry);
  const relay = clientRelaySite(snap, client);
  if (relay && relay.id === entry.id) {
    for (const s of meshSites(snap)) {
      if (!isReachable(s) && clientAllows(client, s.id)) out.push(s);
    }
  }
  return out;
}

/** Reachable sites the client peers with directly (each carries ≥1 site). */
export function clientEntrySites(snap: Snapshot, client: ClientSnapshot): MeshSite[] {
  return hubs(snap).filter((e) => clientCarriedByEntry(snap, client, e).length > 0);
}

/**
 * On gateway `gwSiteId`, which peer carries client `c`'s /32?
 *  - "self": the client is a direct peer of this gateway.
 *  - a site id: this gateway is outbound-only and the client reaches it
 *    through that (reachable) relay site, so the /32 rides that peer.
 *  - null: this gateway never sees the client's traffic.
 */
export function clientRouteFrom(snap: Snapshot, gwSiteId: string, c: ClientSnapshot): "self" | string | null {
  const gw = meshSite(snap, gwSiteId);
  if (clientEntrySites(snap, c).some((e) => e.id === gw.id)) return "self";
  if (!isReachable(gw) && clientAllows(c, gw.id)) {
    const relay = clientRelaySite(snap, c);
    return relay ? relay.id : null;
  }
  return null;
}

/** Outbound-only sites that `hubSiteId` relays client `c` toward. */
export function clientTransitViaHub(snap: Snapshot, hubSiteId: string, c: ClientSnapshot): MeshSite[] {
  const hub = meshSite(snap, hubSiteId);
  return clientCarriedByEntry(snap, c, hub).filter((s) => s.id !== hub.id);
}

// ---------------------------------------------------------------------------
// Single points of failure

export interface SpofReport {
  siteId: string;
  /** Pairs (not involving the site) whose connectivity transits it. */
  severedPairs: Array<[string, string]>;
  /** Clients that lose every entry point if this site dies. */
  strandedClients: string[];
  /** Clients that lose their path to outbound-only sites if this site dies. */
  relayDependentClients: string[];
}

export function spofAnalysis(snap: Snapshot): SpofReport[] {
  return meshSites(snap).map((s) => {
    const severedPairs = relayedPairs(snap, s.id).map(([a, b]) => [a.id, b.id] as [string, string]);
    const strandedClients: string[] = [];
    const relayDependentClients: string[] = [];
    for (const c of activeClients(snap)) {
      const entries = clientEntrySites(snap, c);
      if (entries.length > 0 && entries.every((e) => e.id === s.id)) strandedClients.push(c.id);
      else if (clientTransitViaHub(snap, s.id, c).length > 0) relayDependentClients.push(c.id);
    }
    return { siteId: s.id, severedPairs, strandedClients, relayDependentClients };
  });
}
