/**
 * Topology engine: which gateway pairs peer, how non-peered pairs transit,
 * and what breaks when a site dies.
 *
 * WireGuard's AllowedIPs is both route and filter, and a given prefix can live
 * on exactly one peer per interface. Every routing decision here is therefore
 * a pure deterministic function of the config, so that every node — and both
 * ends of every flow — independently computes the same answer.
 *
 * Rules:
 *  - full-mesh: every pair peers directly. A pair where neither side has an
 *    endpoint cannot connect (validator error; use a hub shape instead).
 *  - multi-hub: sites with endpoints ("capable") all peer with each other;
 *    NAT-bound sites peer with every hub. NAT↔non-hub traffic transits the
 *    first hub (in topology.hubs order) peered with both ends.
 *  - single-hub: every site peers with the hub only; all other pairs transit it.
 *  - Clients: a client peers with every entry point. Sites outside its entry
 *    list are reached via its FIRST entry point; every gateway that is not an
 *    entry point for the client crypto-routes the client's /32 toward that
 *    same first entry point, so forward and return paths agree.
 */
import type { ResolvedConfig, ResolvedSite, ResolvedClient } from "./schema.js";

export type PairStatus =
  | { kind: "direct" }
  | { kind: "transit"; via: string }
  | { kind: "unreachable" };

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function site(cfg: ResolvedConfig, id: string): ResolvedSite {
  const s = cfg.sites.find((x) => x.id === id);
  if (!s) throw new Error(`unknown site "${id}"`);
  return s;
}

/** Unordered site-id pairs that hold a direct WireGuard peering. */
export function peeredPairs(cfg: ResolvedConfig): Set<string> {
  const pairs = new Set<string>();
  const ids = cfg.sites.map((s) => s.id);
  const capable = new Set(cfg.sites.filter((s) => s.gateway.endpoint !== null).map((s) => s.id));

  switch (cfg.topology.shape) {
    case "full-mesh":
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) pairs.add(pairKey(ids[i]!, ids[j]!));
      break;
    case "multi-hub": {
      const hubs = cfg.topology.hubs;
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i]!;
          const b = ids[j]!;
          if (capable.has(a) && capable.has(b)) pairs.add(pairKey(a, b));
          else if (hubs.includes(a) || hubs.includes(b)) pairs.add(pairKey(a, b));
        }
      break;
    }
    case "single-hub": {
      const hub = cfg.topology.hubs[0]!;
      for (const id of ids) if (id !== hub) pairs.add(pairKey(hub, id));
      break;
    }
  }
  return pairs;
}

export function arePeered(cfg: ResolvedConfig, a: string, b: string): boolean {
  return peeredPairs(cfg).has(pairKey(a, b));
}

/**
 * A direct peering can only actually connect if at least one side has a
 * reachable endpoint. In full-mesh, two NAT-bound sites "peer" on paper but
 * can never handshake — surfaced as unreachable so the validator flags it.
 */
function canConnect(cfg: ResolvedConfig, a: string, b: string): boolean {
  return site(cfg, a).gateway.endpoint !== null || site(cfg, b).gateway.endpoint !== null;
}

/** Deterministic, symmetric transit designation for a non-peered pair. */
export function transitVia(cfg: ResolvedConfig, a: string, b: string): string | null {
  const pairs = peeredPairs(cfg);
  for (const h of cfg.topology.hubs) {
    if (h === a || h === b) continue;
    if (
      pairs.has(pairKey(a, h)) &&
      pairs.has(pairKey(h, b)) &&
      canConnect(cfg, a, h) &&
      canConnect(cfg, h, b)
    ) {
      return h;
    }
  }
  return null;
}

export function pairStatus(cfg: ResolvedConfig, a: string, b: string): PairStatus {
  if (arePeered(cfg, a, b)) {
    if (canConnect(cfg, a, b)) return { kind: "direct" };
    const via = transitVia(cfg, a, b);
    return via ? { kind: "transit", via } : { kind: "unreachable" };
  }
  const via = transitVia(cfg, a, b);
  return via ? { kind: "transit", via } : { kind: "unreachable" };
}

export interface MatrixEntry {
  a: string;
  b: string;
  status: PairStatus;
}

/** Full connectivity matrix over unordered site pairs, in stable site order. */
export function connectivityMatrix(cfg: ResolvedConfig): MatrixEntry[] {
  const out: MatrixEntry[] = [];
  for (let i = 0; i < cfg.sites.length; i++)
    for (let j = i + 1; j < cfg.sites.length; j++) {
      const a = cfg.sites[i]!.id;
      const b = cfg.sites[j]!.id;
      out.push({ a, b, status: pairStatus(cfg, a, b) });
    }
  return out;
}

/**
 * The next hop from gateway `from` toward gateway `to`:
 * `to` itself when peered, otherwise the designated transit hub.
 * Null when unreachable.
 */
export function nextHop(cfg: ResolvedConfig, from: string, to: string): string | null {
  const status = pairStatus(cfg, from, to);
  if (status.kind === "direct") return to;
  if (status.kind === "transit") return status.via;
  return null;
}

/**
 * Sites whose traffic gateway `via` carries on behalf of gateway `from`:
 * every site `t` where the next hop from `from` toward `t` is `via` but the
 * final destination is not `via` itself... including `via` is the caller's
 * peer entry anyway. Returns transit-only destinations.
 */
export function transitDestinationsVia(cfg: ResolvedConfig, from: string, via: string): string[] {
  return cfg.sites
    .map((s) => s.id)
    .filter((t) => t !== from && t !== via && nextHop(cfg, from, t) === via);
}

/** The client's designated entry point for all sites outside its entry list. */
export function designatedEntry(client: ResolvedClient): string {
  return client.entryPoints[0]!;
}

/**
 * On gateway `gw`, which peer carries client `c`'s /32?
 *  - `"self"`: gw is one of the client's entry points → the client is a direct peer.
 *  - a site id: next hop toward the client's designated entry point.
 *  - null: the client is unreachable from this gateway (also means the client
 *    cannot reach this site — both sides derive from the same functions).
 */
export function clientRouteFrom(
  cfg: ResolvedConfig,
  gw: string,
  c: ResolvedClient,
): "self" | string | null {
  if (c.entryPoints.includes(gw)) return "self";
  return nextHop(cfg, gw, designatedEntry(c));
}

/**
 * On client `c`, which entry-point peer carries the subnets of site `dest`?
 * Entry sites are reached via their own gateway; everything else goes via the
 * designated (first) entry point, provided a path exists from there.
 */
export function clientPathTo(cfg: ResolvedConfig, c: ResolvedClient, dest: string): string | null {
  if (c.entryPoints.includes(dest)) return dest;
  const entry = designatedEntry(c);
  return pairStatus(cfg, entry, dest).kind === "unreachable" ? null : entry;
}

export interface SpofReport {
  siteId: string;
  /** Pairs (not involving the site) whose connectivity transits it. */
  severedPairs: Array<[string, string]>;
  /** Clients left with no working entry point if this site dies. */
  strandedClients: string[];
}

/** What each site's death would sever, beyond the site itself going dark. */
export function spofAnalysis(cfg: ResolvedConfig): SpofReport[] {
  return cfg.sites.map((s) => {
    const severedPairs: Array<[string, string]> = [];
    for (const e of connectivityMatrix(cfg)) {
      if (e.a === s.id || e.b === s.id) continue;
      if (e.status.kind === "transit" && e.status.via === s.id) severedPairs.push([e.a, e.b]);
    }
    const strandedClients = cfg.clients
      .filter((c) => c.entryPoints.length > 0 && c.entryPoints.every((e) => e === s.id))
      .map((c) => c.id);
    return { siteId: s.id, severedPairs, strandedClients };
  });
}
