/**
 * Mesh graph model: the shape the dashboard diagram draws.
 *
 * Layout is computed here (not in the browser) so it is deterministic,
 * testable, and identical on every reload — a diagram that reshuffles itself
 * on refresh is unreadable. Two layouts, chosen by size:
 *
 *   ring    — sites evenly on a circle, clients on an outer arc near their
 *             entry point. Reads well up to roughly a dozen sites.
 *   cluster — for large meshes: sites on an inner ring, and each site's
 *             clients on a tight satellite arc around it, so 100 nodes stay
 *             legible instead of collapsing into a hairball.
 *
 * Link width and colour come from live throughput; direction comes from which
 * way the bytes are moving. Everything is plain data — the component only
 * renders it.
 */
import type { ResolvedConfig } from "../schema.js";
import { connectivityMatrix, clientPathTo, designatedEntry } from "../topology.js";

export interface GraphNode {
  id: string;
  label: string;
  kind: "gateway" | "client";
  /** Gateways only: hub in a hub topology. */
  isHub: boolean;
  /** "active" | "degraded" | "offline" | "pending" | "unknown" */
  health: string;
  x: number;
  y: number;
  /** Networks behind this node, for the tooltip. */
  detail: string[];
  /** Sum of both directions, bytes/sec, for sizing the node. */
  throughput: number;
}

export interface GraphLink {
  id: string;
  from: string;
  to: string;
  kind: "direct" | "transit" | "client";
  /** bytes/sec from → to */
  rateOut: number;
  /** bytes/sec to → from */
  rateIn: number;
  /** Seconds since the last handshake; null when unknown. */
  handshakeAge: number | null;
  up: boolean;
}

export interface MeshGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  width: number;
  height: number;
  layout: "ring" | "cluster";
  /** Largest single-direction rate, so the component can scale widths. */
  peakRate: number;
}

export interface LiveNodeState {
  lastSeen: number | null;
  lastError: string;
  drift: boolean;
  peers: Array<{ publicKey: string; latestHandshake: number; rxBytes: number; txBytes: number }>;
}

/** Per-link byte rates, keyed "a|b" with a < b lexicographically. */
export type RateLookup = Map<string, { aToB: number; bToA: number }>;

const TAU = Math.PI * 2;

function health(state: LiveNodeState | undefined): string {
  if (!state || state.lastSeen === null) return "unknown";
  if (Date.now() - state.lastSeen > 30_000) return "offline";
  if (state.lastError !== "" || state.drift) return "degraded";
  return "active";
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/**
 * Build the diagram model.
 *
 * @param liveStates  per-site agent reports (may be empty — the diagram still
 *                    renders the intended topology, which is what you want
 *                    when the control node has just started).
 * @param rates       measured per-pair byte rates; absent pairs render idle.
 */
export function buildMeshGraph(
  cfg: ResolvedConfig,
  liveStates: Record<string, LiveNodeState | undefined>,
  rates: RateLookup = new Map(),
): MeshGraph {
  const siteCount = cfg.sites.length;
  const clientCount = cfg.clients.length;
  const total = siteCount + clientCount;

  // Cluster layout once the ring would get crowded.
  const layout: "ring" | "cluster" = total > 14 ? "cluster" : "ring";

  // Canvas grows with node count so labels never collide, but stays in a
  // sensible aspect ratio for a browser panel.
  const size = Math.min(1400, Math.max(600, 420 + total * 26));
  const width = size;
  const height = Math.round(size * 0.72);
  const cx = width / 2;
  const cy = height / 2;
  const siteRadius = Math.min(cx, cy) * (layout === "cluster" ? 0.58 : 0.62);

  const nodes: GraphNode[] = [];
  const sitePos = new Map<string, { x: number; y: number; angle: number }>();

  // Sites evenly around the ring. Starting at -90° puts the first site at the
  // top, which people read as "the primary".
  cfg.sites.forEach((site, i) => {
    const angle = -TAU / 4 + (i / Math.max(1, siteCount)) * TAU;
    const x = cx + Math.cos(angle) * siteRadius;
    const y = cy + Math.sin(angle) * siteRadius;
    sitePos.set(site.id, { x, y, angle });

    const state = liveStates[site.id];
    const detail = site.lans.map((l) => {
      const bits = [l.cidr];
      if (l.name) bits.push(l.name);
      if (l.vlan) bits.push(`VLAN ${l.vlan}`);
      if (l.role !== "standard") bits.push(l.role);
      return bits.join(" · ");
    });

    nodes.push({
      id: site.id,
      label: site.gateway.displayName ?? site.name ?? site.id,
      kind: "gateway",
      isHub: cfg.topology.hubs.includes(site.id),
      health: health(state),
      x,
      y,
      detail,
      throughput: 0,
    });
  });

  // Clients sit just outside their entry point so the picture shows where
  // each one actually connects.
  const perEntry = new Map<string, string[]>();
  for (const c of cfg.clients) {
    const entry = c.entryPoints.length > 0 ? designatedEntry(c) : (cfg.sites[0]?.id ?? "");
    const list = perEntry.get(entry) ?? [];
    list.push(c.id);
    perEntry.set(entry, list);
  }

  for (const [entry, clientIds] of perEntry) {
    const anchor = sitePos.get(entry);
    clientIds.forEach((clientId, i) => {
      const c = cfg.clients.find((x) => x.id === clientId)!;
      // Fan the client satellites out around the site's outward direction.
      const spread = Math.min(TAU * 0.28, 0.22 * clientIds.length);
      const offset = clientIds.length === 1 ? 0 : -spread / 2 + (i / (clientIds.length - 1)) * spread;
      const base = anchor?.angle ?? -TAU / 4;
      const angle = base + offset;
      const r = siteRadius + (layout === "cluster" ? 90 : 120);
      nodes.push({
        id: c.id,
        label: c.displayName ?? c.id,
        kind: "client",
        isHub: false,
        health: "active",
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        detail: [c.tunnelIp, `enters at ${c.entryPoints.join(" → ")}`],
        throughput: 0,
      });
    });
  }

  // --- links ---
  const links: GraphLink[] = [];
  const keyToSite = new Map(cfg.sites.map((s) => [s.gateway.publicKey, s.id]));
  const keyToClient = new Map(cfg.clients.map((c) => [c.publicKey, c.id]));

  /**
   * A client is "active" only if some gateway has actually handshaked with it
   * recently. A configured-but-switched-off phone must not be drawn as
   * connected — the diagram is only useful if it tells the truth.
   */
  const clientHealth = new Map<string, string>();
  for (const c of cfg.clients) {
    let best: number | null = null;
    for (const state of Object.values(liveStates)) {
      if (!state) continue;
      for (const p of state.peers) {
        if (p.publicKey !== c.publicKey || !p.latestHandshake) continue;
        const age = Math.floor(Date.now() / 1000) - p.latestHandshake;
        if (best === null || age < best) best = age;
      }
    }
    clientHealth.set(c.id, best === null ? "offline" : best < 180 ? "active" : "degraded");
  }
  for (const n of nodes) {
    if (n.kind === "client") n.health = clientHealth.get(n.id) ?? "offline";
  }

  /** Most recent handshake seen for a pair, from either end's report. */
  function handshakeFor(a: string, b: string): number | null {
    let newest: number | null = null;
    for (const [siteId, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const state = liveStates[siteId];
      if (!state) continue;
      for (const p of state.peers) {
        const peerId = keyToSite.get(p.publicKey) ?? keyToClient.get(p.publicKey);
        if (peerId !== other || !p.latestHandshake) continue;
        const age = Math.floor(Date.now() / 1000) - p.latestHandshake;
        if (newest === null || age < newest) newest = age;
      }
    }
    return newest;
  }

  for (const e of connectivityMatrix(cfg)) {
    if (e.status.kind === "unreachable") continue;
    // Transit pairs are drawn as the two real hops, not a phantom direct line.
    if (e.status.kind === "transit") {
      for (const [x, y] of [
        [e.a, e.status.via],
        [e.status.via, e.b],
      ] as const) {
        if (links.some((l) => l.id === pairKey(x, y))) continue;
        const rate = rates.get(pairKey(x, y));
        const lo = [x, y].sort()[0]!;
        links.push({
          id: pairKey(x, y),
          from: lo === x ? x : y,
          to: lo === x ? y : x,
          kind: "transit",
          rateOut: rate?.aToB ?? 0,
          rateIn: rate?.bToA ?? 0,
          handshakeAge: handshakeFor(x, y),
          up: true,
        });
      }
      continue;
    }
    const rate = rates.get(pairKey(e.a, e.b));
    const sorted = [e.a, e.b].sort();
    const age = handshakeFor(e.a, e.b);
    links.push({
      id: pairKey(e.a, e.b),
      from: sorted[0]!,
      to: sorted[1]!,
      kind: "direct",
      rateOut: rate?.aToB ?? 0,
      rateIn: rate?.bToA ?? 0,
      handshakeAge: age,
      up: age === null ? false : age < 180,
    });
  }

  // Client links: one per entry point the client actually peers with.
  for (const c of cfg.clients) {
    for (const entry of c.entryPoints) {
      if (clientPathTo(cfg, c, entry) === null) continue;
      const rate = rates.get(pairKey(c.id, entry));
      const sorted = [c.id, entry].sort();
      const age = handshakeFor(entry, c.id);
      links.push({
        id: pairKey(c.id, entry),
        from: sorted[0]!,
        to: sorted[1]!,
        kind: "client",
        rateOut: rate?.aToB ?? 0,
        rateIn: rate?.bToA ?? 0,
        handshakeAge: age,
        up: age === null ? false : age < 180,
      });
    }
  }

  // Node throughput = everything crossing it, used for node sizing.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) {
    const total = l.rateIn + l.rateOut;
    const a = byId.get(l.from);
    const b = byId.get(l.to);
    if (a) a.throughput += total;
    if (b) b.throughput += total;
  }

  const peakRate = links.reduce((m, l) => Math.max(m, l.rateOut, l.rateIn), 0);

  return { nodes, links, width, height, layout, peakRate };
}

/** Human-readable bit rate — the unit operators actually think in. */
export function formatRate(bytesPerSec: number): string {
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gbps`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kbps`;
  if (bits <= 0) return "idle";
  return `${Math.round(bits)} bps`;
}
