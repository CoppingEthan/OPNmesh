/**
 * Semantic validation. Errors hold back the configs they reach (see
 * heldConfigs); warnings are shown.
 *
 * The AllowedIPs and NAT checks re-parse the *generated text* rather than
 * trusting generator internals: a generator bug that puts a subnet against
 * the wrong peer is a routing bug and a security hole at once, and must be
 * caught even when the generator agrees with itself.
 */
import type { Bundle } from "./generate";
import { gatewayPeerAllowedIps } from "./generate/wireguard";
import { cidrContainsIp, cidrHasHostBits, cidrOverlaps, isPrivateCidr, isValidCidr, isValidIpv4, parseCidr } from "./ip";
import type { Snapshot } from "./model";
import { WG_KEY_RE } from "./model";
import {
  activeClients,
  arePeered,
  clientCarriedByEntry,
  clientEntrySites,
  clientRouteFrom,
  connectivityMatrix,
  meshSite,
  meshSites,
  mtuOf,
  reachableSitesFrom,
  spofAnalysis,
  listenPortOf,
} from "./topology";

/** Sites (by id) whose gateway configs, and clients whose configs, a problem reaches. */
export interface Scope {
  sites: string[];
  clients: string[];
}

export interface Finding {
  level: "error" | "warning";
  code: string;
  message: string;
  /** Which object the finding is about, for the UI to link to. */
  subject?: { kind: "site" | "client" | "settings"; id: string };
  /** Errors only: the configs to hold back. Absent means the problem reaches everything. */
  affects?: Scope;
}

const err = (code: string, message: string, subject?: Finding["subject"], affects?: Scope): Finding => ({
  level: "error",
  code,
  message,
  subject,
  ...(affects ? { affects } : {}),
});
const warn = (code: string, message: string, subject?: Finding["subject"]): Finding => ({
  level: "warning",
  code,
  message,
  subject,
});

const NOTHING: Scope = { sites: [], clients: [] };
const ownGateway = (siteId: string): Scope => ({ sites: [siteId], clients: [] });
const ownClient = (clientId: string): Scope => ({ sites: [], clients: [clientId] });

/**
 * Every config that carries a site's addresses, key or endpoint: its own, every
 * gateway with any path to it (its networks sit in their AllowedIPs and
 * firewall sets), and every client that peers with it or reaches it. A site
 * outside the mesh appears in no config at all.
 */
function siteReach(snap: Snapshot, siteId: string): Scope {
  const s = meshSites(snap).find((x) => x.id === siteId);
  if (!s) return NOTHING;
  return {
    sites: [s.id, ...reachableSitesFrom(snap, s.id).map((p) => p.id)],
    clients: activeClients(snap)
      .filter((c) => clientEntrySites(snap, c).some((e) => e.id === s.id || clientCarriedByEntry(snap, c, e).some((x) => x.id === s.id)))
      .map((c) => c.id),
  };
}

/** A client's own config and every gateway that peers with it or routes its address. */
function clientReach(snap: Snapshot, clientId: string): Scope {
  const c = snap.clients.find((x) => x.id === clientId);
  if (!c) return NOTHING;
  if (!c.enabled) return ownClient(c.id);
  return { sites: meshSites(snap).filter((s) => clientRouteFrom(snap, s.id, c) !== null).map((s) => s.id), clients: [c.id] };
}

type Owner = { kind: "site" | "client"; id: string };

/** Reach lookups, computed only for owners that have an error and only once: they walk the topology. */
function reachFinder(snap: Snapshot): (owner: Owner) => Scope {
  const cache = new Map<string, Scope>();
  return (owner) => {
    const key = `${owner.kind}:${owner.id}`;
    let r = cache.get(key);
    if (!r) {
      r = owner.kind === "site" ? siteReach(snap, owner.id) : clientReach(snap, owner.id);
      cache.set(key, r);
    }
    return r;
  };
}

function union(...scopes: Scope[]): Scope {
  return { sites: [...new Set(scopes.flatMap((s) => s.sites))], clients: [...new Set(scopes.flatMap((s) => s.clients))] };
}

/**
 * A network this small (/29 or longer: six usable addresses at most) is a
 * dedicated transit network, the size docs/ROUTERS.md recommends: room for
 * the router and the gateway, not for ordinary hosts. Sharing one is safe
 * and lets other sites reach the gateway itself; a larger shared network
 * around a transit-layout gateway is where hosts get asymmetric paths.
 */
const TRANSIT_PREFIX = 29;

function isTransitSized(cidr: string): boolean {
  return (parseCidr(cidr)?.prefix ?? 0) >= TRANSIT_PREFIX;
}

export function validateAddressing(snap: Snapshot): Finding[] {
  const out: Finding[] = [];
  const { gatewayCidr, clientCidr } = snap.settings;

  for (const [name, cidr] of [
    ["gateway range", gatewayCidr],
    ["client range", clientCidr],
  ] as const) {
    if (!isValidCidr(cidr)) out.push(err("bad-cidr", `${name} "${cidr}" is not a valid network`, { kind: "settings", id: "settings" }));
    else if (cidrHasHostBits(cidr)) out.push(err("host-bits", `${name} ${cidr} has host bits set`, { kind: "settings", id: "settings" }));
  }
  if (isValidCidr(gatewayCidr) && isValidCidr(clientCidr) && cidrOverlaps(gatewayCidr, clientCidr)) {
    out.push(err("overlap", `gateway range ${gatewayCidr} overlaps client range ${clientCidr}`, { kind: "settings", id: "settings" }));
  }

  // A site's networks, tunnel address, key and endpoint are written into
  // every config that reaches it, so a fault in any of them reaches as far.
  const reach = reachFinder(snap);
  const siteScope = (id: string) => reach({ kind: "site", id });

  for (const s of snap.sites) {
    const subj = { kind: "site" as const, id: s.id };
    for (const lan of s.lans) {
      if (!isValidCidr(lan.cidr)) {
        out.push(err("bad-cidr", `${s.name}: "${lan.cidr}" is not a valid network`, subj, siteScope(s.id)));
        continue;
      }
      if (cidrHasHostBits(lan.cidr)) out.push(err("host-bits", `${s.name}: ${lan.cidr} has host bits set — use the network address`, subj, siteScope(s.id)));
      for (const [name, cidr] of [
        ["gateway range", gatewayCidr],
        ["client range", clientCidr],
      ] as const) {
        if (cidrOverlaps(lan.cidr, cidr)) out.push(err("overlap", `${s.name}: network ${lan.cidr} overlaps the ${name} ${cidr}`, subj, siteScope(s.id)));
      }
      // A warning, not an error: some organisations number internal networks
      // from public space they own. Everyone else has probably made a typo
      // that would route someone else's addresses into the mesh.
      if (lan.shared && !isPrivateCidr(lan.cidr)) {
        out.push(warn("public-lan", `${s.name}: shared network ${lan.cidr} is not private address space — every site will route it into the mesh`, subj));
      }
    }
    for (let i = 0; i < s.lans.length; i++) {
      for (let j = i + 1; j < s.lans.length; j++) {
        const a = s.lans[i]!;
        const b = s.lans[j]!;
        if (cidrOverlaps(a.cidr, b.cidr)) out.push(err("overlap", `${s.name}: networks ${a.cidr} and ${b.cidr} overlap`, subj, siteScope(s.id)));
      }
    }
    if (s.gateway) {
      // The LAN address only reaches this site's router plan and gateway.
      if (!isValidIpv4(s.gateway.lanIp)) out.push(err("bad-ip", `${s.name}: gateway address "${s.gateway.lanIp}" is not valid`, subj, ownGateway(s.id)));
      if (!cidrContainsIp(gatewayCidr, s.gateway.tunnelIp)) {
        out.push(err("tunnel-ip", `${s.name}: tunnel address ${s.gateway.tunnelIp} is outside ${gatewayCidr}`, subj, siteScope(s.id)));
      }
      if (s.routerLayout === "same_lan" && !s.lans.some((l) => cidrContainsIp(l.cidr, s.gateway!.lanIp))) {
        out.push(warn("lan-ip", `${s.name}: the gateway address ${s.gateway.lanIp} is not inside any of the site's networks, but the layout is "same LAN"`, subj));
      }
      const hostLan = s.routerLayout === "transit" ? s.lans.find((l) => l.shared && cidrContainsIp(l.cidr, s.gateway!.lanIp) && !isTransitSized(l.cidr)) : undefined;
      if (hostLan) {
        out.push(
          warn(
            "lan-ip",
            `${s.name}: the gateway address ${s.gateway.lanIp} sits inside the shared network ${hostLan.cidr}, but the layout is "transit network" — hosts on ${hostLan.cidr} would reach other sites through the router but get replies straight from the gateway, so the router sees half of each connection and TCP can hang. Put the gateway on a dedicated transit network (a /${TRANSIT_PREFIX} holding only the router and the gateway), or use the "same LAN" layout`,
            subj,
          ),
        );
      }
      if (!WG_KEY_RE.test(s.gateway.publicKey)) out.push(err("bad-key", `${s.name}: gateway public key is malformed`, subj, siteScope(s.id)));
      const port = listenPortOf(snap, s as never);
      if (port < 1 || port > 65535) out.push(err("bad-port", `${s.name}: listen port ${port} is out of range`, subj, siteScope(s.id)));
      if (s.gateway.endpointHost !== null && s.gateway.endpointHost.includes(":")) {
        out.push(err("bad-endpoint", `${s.name}: endpoint must be a host only; the port comes from the listen port`, subj, siteScope(s.id)));
      }
    }
    if (s.gateway && s.lans.filter((l) => l.shared).length === 0) {
      out.push(warn("no-shared-lan", `${s.name} shares no networks with the mesh — nothing can be reached there`, subj));
    }
  }

  // Cross-site overlaps between shared networks.
  for (let i = 0; i < snap.sites.length; i++) {
    for (let j = i + 1; j < snap.sites.length; j++) {
      const a = snap.sites[i]!;
      const b = snap.sites[j]!;
      for (const la of a.lans) {
        for (const lb of b.lans) {
          if (!la.shared || !lb.shared) continue;
          if (cidrOverlaps(la.cidr, lb.cidr)) {
            // Only a conflict once both sites are in the mesh; until then no config holds both.
            const ra = siteScope(a.id);
            const rb = siteScope(b.id);
            const scope = ra.sites.length > 0 && rb.sites.length > 0 ? union(ra, rb) : NOTHING;
            out.push(err("overlap", `${a.name} network ${la.cidr} overlaps ${b.name} network ${lb.cidr} — two sites cannot share an address range`, { kind: "site", id: b.id }, scope));
          }
        }
      }
    }
  }

  type Named = Owner & { name: string };
  const tunnelIps = new Map<string, Named>();
  const keys = new Map<string, Named>();
  for (const s of snap.sites) {
    if (!s.gateway) continue;
    const me: Named = { name: s.name, kind: "site", id: s.id };
    const prev = tunnelIps.get(s.gateway.tunnelIp);
    if (prev) out.push(err("dup-ip", `tunnel address ${s.gateway.tunnelIp} is used by both ${prev.name} and ${s.name}`, { kind: "site", id: s.id }, union(reach(prev), reach(me))));
    tunnelIps.set(s.gateway.tunnelIp, me);
    const pk = keys.get(s.gateway.publicKey);
    if (pk) out.push(err("dup-key", `${pk.name} and ${s.name} share a public key — every gateway needs its own`, { kind: "site", id: s.id }, union(reach(pk), reach(me))));
    keys.set(s.gateway.publicKey, me);
  }
  for (const c of snap.clients) {
    const subj = { kind: "client" as const, id: c.id };
    const me: Named = { name: c.name, kind: "client", id: c.id };
    if (!cidrContainsIp(clientCidr, c.tunnelIp)) out.push(err("client-ip", `${c.name}: address ${c.tunnelIp} is outside the client range ${clientCidr}`, subj, reach(me)));
    const prev = tunnelIps.get(c.tunnelIp);
    if (prev) out.push(err("dup-ip", `address ${c.tunnelIp} is used by both ${prev.name} and ${c.name}`, subj, union(reach(prev), reach(me))));
    tunnelIps.set(c.tunnelIp, me);
    if (!WG_KEY_RE.test(c.publicKey)) out.push(err("bad-key", `${c.name}: public key is malformed`, subj, reach(me)));
    const pk = keys.get(c.publicKey);
    if (pk) out.push(err("dup-key", `${pk.name} and ${c.name} share a public key`, subj, union(reach(pk), reach(me))));
    keys.set(c.publicKey, me);
    // A reference to a deleted site changes no generated text; only the client's own config is in question.
    if (c.allowedSiteIds !== null) {
      for (const id of c.allowedSiteIds) {
        if (!snap.sites.some((s) => s.id === id)) out.push(err("bad-ref", `${c.name}: allowed site "${id}" does not exist`, subj, ownClient(c.id)));
      }
    }
    if (c.preferredSiteId !== null && !snap.sites.some((s) => s.id === c.preferredSiteId)) {
      out.push(err("bad-ref", `${c.name}: preferred site "${c.preferredSiteId}" does not exist`, subj, ownClient(c.id)));
    }
  }

  const byEndpoint = new Map<string, { id: string; name: string }>();
  for (const s of meshSites(snap)) {
    if (s.gateway.endpointHost === null) continue;
    const key = `${s.gateway.endpointHost}:${listenPortOf(snap, s)}`;
    const prev = byEndpoint.get(key);
    if (prev) out.push(err("port-collision", `${prev.name} and ${s.name} both publish ${key} — one host and port cannot serve two gateways`, { kind: "site", id: s.id }, union(siteScope(prev.id), siteScope(s.id))));
    byEndpoint.set(key, { id: s.id, name: s.name });
  }

  return out;
}

interface ParsedPeer {
  comment: string | null;
  publicKey: string | null;
  allowedIps: string[];
}

export function parsePeers(conf: string): ParsedPeer[] {
  const peers: ParsedPeer[] = [];
  let current: ParsedPeer | null = null;
  for (const raw of conf.split("\n")) {
    const line = raw.trim();
    if (line === "[Peer]") {
      current = { comment: null, publicKey: null, allowedIps: [] };
      peers.push(current);
    } else if (current) {
      if (line.startsWith("#")) current.comment ??= line.slice(1).trim();
      else if (line.startsWith("PublicKey")) current.publicKey = line.slice(line.indexOf("=") + 1).trim();
      else if (line.startsWith("AllowedIPs")) {
        current.allowedIps = line
          .slice(line.indexOf("=") + 1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
  }
  return peers;
}

/** Prefixes shorter than this route most of the internet into the mesh. */
const MIN_PREFIX = 8;

export function validateAllowedIps(snap: Snapshot, bundle: Bundle): Finding[] {
  const out: Finding[] = [];
  // Each finding here is about the one generated file it was read from, so
  // it holds exactly that config; a fault that spreads is found in each file.
  const checkPrefixes = (owner: string, ips: string[], subject: Finding["subject"], scope: Scope) => {
    for (const ip of ips) {
      const c = parseCidr(ip);
      if (!c) {
        out.push(err("allowedips-parse", `${owner}: unparseable AllowedIPs entry "${ip}"`, subject, scope));
        continue;
      }
      if (c.prefix === 0) out.push(err("default-route", `${owner}: AllowedIPs contains a default route (${ip})`, subject, scope));
      else if (c.prefix < MIN_PREFIX) out.push(err("default-route", `${owner}: AllowedIPs contains ${ip}, which covers most of the internet`, subject, scope));
    }
  };

  const siteBySlug = new Map(meshSites(snap).map((s) => [s.slug, s]));
  const clientBySlug = new Map(snap.clients.map((c) => [c.slug, c]));

  for (const g of meshSites(snap)) {
    const subject = { kind: "site" as const, id: g.id };
    const scope = ownGateway(g.id);
    const conf = bundle.gateways[g.gateway.id]?.files["wireguard.conf"];
    if (!conf) {
      out.push(err("missing-config", `no generated WireGuard config for ${g.name}`, subject, scope));
      continue;
    }
    const seen = new Map<string, string>();
    for (const peer of parsePeers(conf)) {
      const label = peer.comment ?? "?";
      const owner = `${g.name} peer "${label}"`;
      checkPrefixes(owner, peer.allowedIps, subject, scope);
      for (const ip of peer.allowedIps) {
        const prev = seen.get(ip);
        if (prev) out.push(err("duplicate-prefix", `${g.name}: ${ip} appears on peers "${prev}" and "${label}"`, subject, scope));
        seen.set(ip, label);
      }

      let expected: string[];
      if (label.startsWith("client:")) {
        const c = clientBySlug.get(label.slice("client:".length).trim());
        if (!c) {
          out.push(err("unknown-peer", `${owner}: no such client`, subject, scope));
          continue;
        }
        if (!clientEntrySites(snap, c).some((e) => e.id === g.id)) out.push(err("wrong-peer", `${owner}: this gateway is not an entry point for the client`, subject, scope));
        expected = [`${c.tunnelIp}/32`];
      } else if (label.startsWith("site:")) {
        const p = siteBySlug.get(label.slice("site:".length).trim());
        if (!p) {
          out.push(err("unknown-peer", `${owner}: no such site`, subject, scope));
          continue;
        }
        if (!arePeered(snap, g.id, p.id)) {
          out.push(err("wrong-peer", `${owner}: these sites should not peer directly`, subject, scope));
          continue;
        }
        expected = gatewayPeerAllowedIps(snap, g, p);
      } else {
        out.push(err("unknown-peer", `${owner}: unlabelled peer`, subject, scope));
        continue;
      }
      const got = [...peer.allowedIps].sort().join(",");
      const want = [...expected].sort().join(",");
      if (got !== want) out.push(err("allowedips-mismatch", `${owner}: AllowedIPs [${peer.allowedIps.join(", ")}] differs from expected [${expected.join(", ")}]`, subject, scope));
    }
  }

  for (const c of activeClients(snap)) {
    const subject = { kind: "client" as const, id: c.id };
    const scope = ownClient(c.id);
    const conf = bundle.clients[c.id]?.conf;
    if (!conf) {
      out.push(err("missing-config", `no generated config for client ${c.name}`, subject, scope));
      continue;
    }
    const seen = new Map<string, string>();
    for (const peer of parsePeers(conf)) {
      const owner = `client ${c.name} peer "${peer.comment ?? "?"}"`;
      checkPrefixes(owner, peer.allowedIps, subject, scope);
      for (const ip of peer.allowedIps) {
        const prev = seen.get(ip);
        if (prev) out.push(err("duplicate-prefix", `${c.name}: ${ip} appears on peers "${prev}" and "${peer.comment}"`, subject, scope));
        seen.set(ip, peer.comment ?? "?");
      }
    }
  }
  return out;
}

/** NAT is allowed only on masquerade-layout gateways, and only as generated. */
export function validateNat(snap: Snapshot, bundle: Bundle): Finding[] {
  const out: Finding[] = [];
  for (const g of meshSites(snap)) {
    const files = bundle.gateways[g.gateway.id]?.files;
    if (!files) continue;
    for (const [name, content] of Object.entries(files)) {
      for (const [i, line] of content.split("\n").entries()) {
        if (/\bmasquerade\b|\bsnat\b/i.test(line) && !line.trim().startsWith("#")) {
          if (g.routerLayout !== "masquerade") {
            out.push(err("nat", `${g.name} ${name}:${i + 1}: NAT rule present on a site that is not in masquerade layout`, { kind: "site", id: g.id }, ownGateway(g.id)));
          }
        }
      }
    }
  }
  return out;
}

export function validateMtu(snap: Snapshot): Finding[] {
  const out: Finding[] = [];
  // The default MTU is in every config; a site's own only in its gateway's.
  const all = [
    { name: "default", mtu: snap.settings.mtu, subject: { kind: "settings" as const, id: "settings" }, scope: undefined },
    ...meshSites(snap).map((s) => ({ name: s.name, mtu: mtuOf(snap, s), subject: { kind: "site" as const, id: s.id }, scope: ownGateway(s.id) })),
  ];
  for (const { name, mtu, subject, scope } of all) {
    if (mtu < 1280 || mtu > 1500) out.push(err("mtu-range", `${name}: MTU ${mtu} is outside 1280–1500`, subject, scope));
    else if (mtu > 1420) out.push(warn("mtu-high", `${name}: MTU ${mtu} exceeds 1420 — WireGuard overhead will not fit a 1500-byte WAN; large transfers may stall`, subject));
  }
  return out;
}

export function validateTopology(snap: Snapshot): Finding[] {
  const out: Finding[] = [];
  const name = (id: string) => meshSite(snap, id).name;
  for (const e of connectivityMatrix(snap)) {
    if (e.status.kind === "unreachable") {
      // Nothing to hold: both configs are right, they just have no path to
      // each other, and holding them would withhold a first configuration.
      out.push(err("unreachable-pair", `${name(e.a)} and ${name(e.b)} cannot connect: neither accepts incoming connections and no site does — open a UDP port at one of your sites`, { kind: "site", id: e.b }, NOTHING));
    }
  }
  const hubList = meshSites(snap).filter((s) => s.gateway.endpointHost !== null);
  if (meshSites(snap).length > 1 && hubList.length === 1) {
    out.push(warn("single-hub", `${hubList[0]!.name} is the only site accepting incoming connections — if it goes down, every other site loses contact`, { kind: "site", id: hubList[0]!.id }));
  }
  for (const r of spofAnalysis(snap)) {
    if (r.severedPairs.length > 0 && hubList.length > 1) {
      const pairs = r.severedPairs.map(([a, b]) => `${name(a)} ↔ ${name(b)}`).join(", ");
      out.push(warn("spof", `if ${name(r.siteId)} goes down these lose contact: ${pairs}`, { kind: "site", id: r.siteId }));
    }
    for (const cid of r.strandedClients) {
      const c = snap.clients.find((x) => x.id === cid)!;
      if (hubList.length > 1) out.push(warn("client-single-entry", `${c.name} can only connect through ${name(r.siteId)}`, { kind: "client", id: cid }));
    }
  }
  for (const c of activeClients(snap)) {
    if (clientEntrySites(snap, c).length === 0) {
      out.push(warn("client-no-entry", `${c.name} has no site to connect to — no reachable site is allowed for it`, { kind: "client", id: c.id }));
    }
  }
  return out;
}

/** Run everything, errors first. */
export function validateAll(snap: Snapshot, bundle: Bundle): Finding[] {
  return [
    ...validateAddressing(snap),
    ...validateAllowedIps(snap, bundle),
    ...validateNat(snap, bundle),
    ...validateMtu(snap),
    ...validateTopology(snap),
  ].sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}

/** Configs that must not be handed out, each with the first error that holds it. */
export interface Held {
  /** gateway id → reason */
  gateways: Record<string, string>;
  /** client id → reason */
  clients: Record<string, string>;
}

/**
 * What a held gateway itself is told: which kind of error holds it and
 * where, never the finding's message, which names other sites, their
 * networks and their endpoints. The first error that holds the site is the
 * one heldConfigs reports to the admin. Null when nothing holds it.
 */
export function heldNotice(findings: Finding[], siteId: string): string | null {
  const f = findings.find((x) => x.level === "error" && (!x.affects || x.affects.sites.includes(siteId)));
  if (!f) return null;
  const where = !f.subject
    ? ""
    : f.subject.kind === "settings"
      ? " in the network settings"
      : f.subject.kind === "client"
        ? " in a roaming client"
        : f.subject.id === siteId
          ? " at this site"
          : " at another site";
  return `configuration on hold until an error is fixed in the OPNmesh UI (${f.code}${where})`;
}

/**
 * What the error findings hold back. A held gateway keeps running its last
 * good configuration; a held client's config is not rendered at all. An
 * error without a scope (a broken address range, say) holds everything.
 */
export function heldConfigs(snap: Snapshot, findings: Finding[]): Held {
  const held: Held = { gateways: {}, clients: {} };
  const gatewayOf = new Map(meshSites(snap).map((s) => [s.id, s.gateway.id]));
  for (const f of findings) {
    if (f.level !== "error") continue;
    const sites = f.affects ? f.affects.sites : [...gatewayOf.keys()];
    const clients = f.affects ? f.affects.clients : snap.clients.map((c) => c.id);
    for (const id of sites) {
      const gw = gatewayOf.get(id);
      if (gw !== undefined) held.gateways[gw] ??= f.message;
    }
    for (const id of clients) held.clients[id] ??= f.message;
  }
  return held;
}
