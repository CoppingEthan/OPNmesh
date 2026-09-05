/**
 * Derived status for gateways, tunnels and clients — pure functions of
 * database rows and live state, shared by the API, the SSE stream and pages.
 */
import type { ClientRow, GatewayRow } from "@/db/schema";
import { pairCounterName, clientCounterNames } from "@/core/generate/nftables";
import { connectivityMatrix, meshSites, type MeshSite } from "@/core/topology";
import type { Snapshot } from "@/core/model";
import type { Bundle } from "@/core/generate";
import type { LiveGateway, LiveState } from "./live";

export type GatewayHealth = "online" | "stale" | "offline" | "pending" | "disabled" | "never";

export interface GatewayView {
  gatewayId: string;
  siteId: string;
  siteSlug: string;
  health: GatewayHealth;
  /** Something needs attention even though the gateway is online. */
  attention: string | null;
  lastSeenAt: number | null;
  agentVersion: string;
  appliedHash: string;
  desiredHash: string;
  configCurrent: boolean;
  lastError: string;
  load1: number | null;
  memUsedPct: number | null;
  uptimeSeconds: number | null;
}

export function gatewayHealth(row: GatewayRow, live: LiveGateway | undefined, now: number, intervalS: number): GatewayHealth {
  if (row.status === "pending") return "pending";
  if (row.status === "disabled") return "disabled";
  const seen = live?.at ?? row.lastSeenAt;
  if (!seen) return "never";
  const age = (now - seen) / 1000;
  if (age <= intervalS * 3) return "online";
  if (age <= intervalS * 12) return "stale";
  return "offline";
}

export function gatewayView(row: GatewayRow, siteSlug: string, live: LiveGateway | undefined, desiredHash: string, now: number, intervalS: number): GatewayView {
  const health = gatewayHealth(row, live, now, intervalS);
  const applied = live?.report.appliedHash ?? row.appliedHash;
  const lastError = live?.report.lastError ?? row.lastError;
  let attention: string | null = null;
  if (health === "online" || health === "stale") {
    if (lastError) attention = lastError;
    else if (desiredHash && applied !== desiredHash) attention = "configuration change not yet applied";
    else if (live && !live.report.interfaceUp) attention = "tunnel interface is down";
  }
  return {
    gatewayId: row.id,
    siteId: row.siteId,
    siteSlug,
    health,
    attention,
    lastSeenAt: live?.at ?? row.lastSeenAt,
    agentVersion: live?.report.version ?? row.agentVersion,
    appliedHash: applied,
    desiredHash,
    configCurrent: applied === desiredHash,
    lastError,
    load1: live?.report.host.load1 ?? null,
    memUsedPct: live?.report.host.memUsedPct ?? null,
    uptimeSeconds: live?.report.uptimeSeconds ?? null,
  };
}

export type TunnelHealth = "up" | "handshake-only" | "down" | "unknown";

export interface TunnelView {
  /** Site ids, a < b by slug order. */
  a: string;
  b: string;
  kind: "direct" | "transit" | "unreachable";
  via: string | null;
  health: TunnelHealth;
  /** Bytes per second from a toward b and b toward a. */
  aToB: number;
  bToA: number;
  rttMs: number | null;
  handshakeAgeS: number | null;
}

function peerFrom(live: LiveGateway | undefined, publicKey: string) {
  return live?.report.peers.find((p) => p.publicKey === publicKey);
}

/** One entry per mesh pair. Direct pairs carry live tunnel numbers. */
export function tunnelViews(snap: Snapshot, live: LiveState, now: number): TunnelView[] {
  const sites = meshSites(snap);
  const byId = new Map(sites.map((s) => [s.id, s]));
  return connectivityMatrix(snap).map((e) => {
    const a = byId.get(e.a)!;
    const b = byId.get(e.b)!;
    const base: TunnelView = {
      a: a.id,
      b: b.id,
      kind: e.status.kind,
      via: e.status.kind === "transit" ? e.status.via : null,
      health: "unknown",
      aToB: 0,
      bToA: 0,
      rttMs: null,
      handshakeAgeS: null,
    };
    if (e.status.kind !== "direct") return base;
    const la = live.get(a.gateway.id);
    const lb = live.get(b.gateway.id);
    const pa = peerFrom(la, b.gateway.publicKey); // a's view of b
    const pb = peerFrom(lb, a.gateway.publicKey); // b's view of a
    const ra = la?.peerRates.get(b.gateway.publicKey);
    const rb = lb?.peerRates.get(a.gateway.publicKey);
    // a→b is what a transmitted to b, or what b received from a; take the fresher side.
    base.aToB = Math.max(ra?.txBps ?? 0, rb?.rxBps ?? 0);
    base.bToA = Math.max(ra?.rxBps ?? 0, rb?.txBps ?? 0);
    const rtts = [pa?.rttMs, pb?.rttMs].filter((x): x is number => typeof x === "number");
    base.rttMs = rtts.length ? Math.min(...rtts) : null;
    const hs = Math.max(pa?.latestHandshake ?? 0, pb?.latestHandshake ?? 0);
    base.handshakeAgeS = hs > 0 ? Math.max(0, Math.floor(now / 1000 - hs)) : null;
    if (!la && !lb) base.health = "unknown";
    else if (base.handshakeAgeS !== null && base.handshakeAgeS < 180 && base.rttMs !== null) base.health = "up";
    else if (base.handshakeAgeS !== null && base.handshakeAgeS < 180) base.health = "handshake-only";
    else base.health = "down";
    return base;
  });
}

export interface ClientView {
  id: string;
  name: string;
  slug: string;
  tunnelIp: string;
  enabled: boolean;
  online: boolean;
  lastHandshakeAt: number | null;
  /** Site the client most recently handshook with. */
  viaSiteId: string | null;
  rxBps: number;
  txBps: number;
  endpoint: string | null;
}

export function clientViews(clientsRows: ClientRow[], snap: Snapshot, live: LiveState, now: number): ClientView[] {
  const sites = meshSites(snap);
  return clientsRows.map((c) => {
    let best: { site: MeshSite; hs: number; rx: number; tx: number; endpoint: string | null } | null = null;
    for (const s of sites) {
      const l = live.get(s.gateway.id);
      const p = peerFrom(l, c.publicKey);
      if (!p) continue;
      const r = l?.peerRates.get(c.publicKey);
      if (!best || p.latestHandshake > best.hs) {
        best = { site: s, hs: p.latestHandshake, rx: r?.rxBps ?? 0, tx: r?.txBps ?? 0, endpoint: p.endpoint };
      }
    }
    const lastHs = best && best.hs > 0 ? best.hs * 1000 : c.lastHandshakeAt;
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      tunnelIp: c.tunnelIp,
      enabled: c.enabled,
      online: !!lastHs && now - lastHs < 180_000,
      lastHandshakeAt: lastHs ?? null,
      viaSiteId: best && best.hs > 0 ? best.site.id : null,
      // From the gateway's point of view rx is what the client sent.
      rxBps: best?.tx ?? 0,
      txBps: best?.rx ?? 0,
      endpoint: best?.endpoint ?? null,
    };
  });
}

export interface PairRateView {
  fromSiteId: string;
  toSiteId: string;
  bps: number;
}

/**
 * Site-to-site routed traffic from nftables counters. Each ordered pair is
 * counted on both endpoint gateways (and on a relaying hub); the maximum is
 * taken so a missing report from one side does not zero the figure.
 */
export function pairRateViews(snap: Snapshot, live: LiveState): PairRateView[] {
  const sites = meshSites(snap);
  const out = new Map<string, PairRateView>();
  for (const from of sites) {
    for (const to of sites) {
      if (from.id === to.id) continue;
      const name = pairCounterName(from, to);
      let bps = 0;
      for (const l of live.all()) bps = Math.max(bps, l.counterRates.get(name) ?? 0);
      out.set(`${from.id}|${to.id}`, { fromSiteId: from.id, toSiteId: to.id, bps });
    }
  }
  return [...out.values()];
}

export interface ClientSiteRateView {
  siteId: string;
  toSite: number;
  fromSite: number;
}

export function clientSiteRates(snap: Snapshot, live: LiveState): ClientSiteRateView[] {
  return meshSites(snap).map((s) => {
    const names = clientCounterNames(s);
    const l = live.get(s.gateway.id);
    return { siteId: s.id, toSite: l?.counterRates.get(names.toSite) ?? 0, fromSite: l?.counterRates.get(names.fromSite) ?? 0 };
  });
}

export function desiredHashFor(bundle: Bundle, gatewayId: string): string {
  return bundle.gateways[gatewayId]?.hash ?? "";
}
