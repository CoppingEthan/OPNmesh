/**
 * Semantic validation. Errors block a change; warnings are shown.
 *
 * The AllowedIPs and NAT checks re-parse the *generated text* rather than
 * trusting generator internals: a generator bug that puts a subnet against
 * the wrong peer is a routing bug and a security hole at once, and must be
 * caught even when the generator agrees with itself.
 */
import type { Bundle } from "./generate";
import { gatewayPeerAllowedIps } from "./generate/wireguard";
import { cidrContainsIp, cidrHasHostBits, cidrOverlaps, isValidCidr, isValidIpv4, parseCidr } from "./ip";
import type { Snapshot } from "./model";
import { WG_KEY_RE } from "./model";
import {
  activeClients,
  arePeered,
  clientEntrySites,
  connectivityMatrix,
  meshSite,
  meshSites,
  mtuOf,
  spofAnalysis,
  listenPortOf,
} from "./topology";

export interface Finding {
  level: "error" | "warning";
  code: string;
  message: string;
  /** Which object the finding is about, for the UI to link to. */
  subject?: { kind: "site" | "client" | "settings"; id: string };
}

const err = (code: string, message: string, subject?: Finding["subject"]): Finding => ({
  level: "error",
  code,
  message,
  subject,
});
const warn = (code: string, message: string, subject?: Finding["subject"]): Finding => ({
  level: "warning",
  code,
  message,
  subject,
});

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

  for (const s of snap.sites) {
    const subj = { kind: "site" as const, id: s.id };
    for (const lan of s.lans) {
      if (!isValidCidr(lan.cidr)) {
        out.push(err("bad-cidr", `${s.name}: "${lan.cidr}" is not a valid network`, subj));
        continue;
      }
      if (cidrHasHostBits(lan.cidr)) out.push(err("host-bits", `${s.name}: ${lan.cidr} has host bits set — use the network address`, subj));
      for (const [name, cidr] of [
        ["gateway range", gatewayCidr],
        ["client range", clientCidr],
      ] as const) {
        if (cidrOverlaps(lan.cidr, cidr)) out.push(err("overlap", `${s.name}: network ${lan.cidr} overlaps the ${name} ${cidr}`, subj));
      }
    }
    for (let i = 0; i < s.lans.length; i++) {
      for (let j = i + 1; j < s.lans.length; j++) {
        const a = s.lans[i]!;
        const b = s.lans[j]!;
        if (cidrOverlaps(a.cidr, b.cidr)) out.push(err("overlap", `${s.name}: networks ${a.cidr} and ${b.cidr} overlap`, subj));
      }
    }
    if (s.gateway) {
      if (!isValidIpv4(s.gateway.lanIp)) out.push(err("bad-ip", `${s.name}: gateway address "${s.gateway.lanIp}" is not valid`, subj));
      if (!cidrContainsIp(gatewayCidr, s.gateway.tunnelIp)) {
        out.push(err("tunnel-ip", `${s.name}: tunnel address ${s.gateway.tunnelIp} is outside ${gatewayCidr}`, subj));
      }
      if (s.routerLayout === "same_lan" && !s.lans.some((l) => cidrContainsIp(l.cidr, s.gateway!.lanIp))) {
        out.push(warn("lan-ip", `${s.name}: the gateway address ${s.gateway.lanIp} is not inside any of the site's networks, but the layout is "same LAN"`, subj));
      }
      if (s.routerLayout === "transit" && s.lans.some((l) => l.shared && cidrContainsIp(l.cidr, s.gateway!.lanIp))) {
        out.push(warn("lan-ip", `${s.name}: the gateway address ${s.gateway.lanIp} sits inside a shared LAN, but the layout is "transit network"`, subj));
      }
      if (!WG_KEY_RE.test(s.gateway.publicKey)) out.push(err("bad-key", `${s.name}: gateway public key is malformed`, subj));
      const port = listenPortOf(snap, s as never);
      if (port < 1 || port > 65535) out.push(err("bad-port", `${s.name}: listen port ${port} is out of range`, subj));
      if (s.gateway.endpointHost !== null && s.gateway.endpointHost.includes(":")) {
        out.push(err("bad-endpoint", `${s.name}: endpoint must be a host only; the port comes from the listen port`, subj));
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
            out.push(err("overlap", `${a.name} network ${la.cidr} overlaps ${b.name} network ${lb.cidr} — two sites cannot share an address range`, { kind: "site", id: b.id }));
          }
        }
      }
    }
  }

  const tunnelIps = new Map<string, string>();
  const keys = new Map<string, string>();
  for (const s of snap.sites) {
    if (!s.gateway) continue;
    const prev = tunnelIps.get(s.gateway.tunnelIp);
    if (prev) out.push(err("dup-ip", `tunnel address ${s.gateway.tunnelIp} is used by both ${prev} and ${s.name}`, { kind: "site", id: s.id }));
    tunnelIps.set(s.gateway.tunnelIp, s.name);
    const pk = keys.get(s.gateway.publicKey);
    if (pk) out.push(err("dup-key", `${prev ?? pk} and ${s.name} share a public key — every gateway needs its own`, { kind: "site", id: s.id }));
    keys.set(s.gateway.publicKey, s.name);
  }
  for (const c of snap.clients) {
    const subj = { kind: "client" as const, id: c.id };
    if (!cidrContainsIp(clientCidr, c.tunnelIp)) out.push(err("client-ip", `${c.name}: address ${c.tunnelIp} is outside the client range ${clientCidr}`, subj));
    const prev = tunnelIps.get(c.tunnelIp);
    if (prev) out.push(err("dup-ip", `address ${c.tunnelIp} is used by both ${prev} and ${c.name}`, subj));
    tunnelIps.set(c.tunnelIp, c.name);
    if (!WG_KEY_RE.test(c.publicKey)) out.push(err("bad-key", `${c.name}: public key is malformed`, subj));
    const pk = keys.get(c.publicKey);
    if (pk) out.push(err("dup-key", `${pk} and ${c.name} share a public key`, subj));
    keys.set(c.publicKey, c.name);
    if (c.allowedSiteIds !== null) {
      for (const id of c.allowedSiteIds) {
        if (!snap.sites.some((s) => s.id === id)) out.push(err("bad-ref", `${c.name}: allowed site "${id}" does not exist`, subj));
      }
    }
    if (c.preferredSiteId !== null && !snap.sites.some((s) => s.id === c.preferredSiteId)) {
      out.push(err("bad-ref", `${c.name}: preferred site "${c.preferredSiteId}" does not exist`, subj));
    }
  }

  const byEndpoint = new Map<string, string>();
  for (const s of meshSites(snap)) {
    if (s.gateway.endpointHost === null) continue;
    const key = `${s.gateway.endpointHost}:${listenPortOf(snap, s)}`;
    const prev = byEndpoint.get(key);
    if (prev) out.push(err("port-collision", `${prev} and ${s.name} both publish ${key} — one host and port cannot serve two gateways`, { kind: "site", id: s.id }));
    byEndpoint.set(key, s.name);
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
  const checkPrefixes = (owner: string, ips: string[], subject: Finding["subject"]) => {
    for (const ip of ips) {
      const c = parseCidr(ip);
      if (!c) {
        out.push(err("allowedips-parse", `${owner}: unparseable AllowedIPs entry "${ip}"`, subject));
        continue;
      }
      if (c.prefix === 0) out.push(err("default-route", `${owner}: AllowedIPs contains a default route (${ip})`, subject));
      else if (c.prefix < MIN_PREFIX) out.push(err("default-route", `${owner}: AllowedIPs contains ${ip}, which covers most of the internet`, subject));
    }
  };

  const siteBySlug = new Map(meshSites(snap).map((s) => [s.slug, s]));
  const clientBySlug = new Map(snap.clients.map((c) => [c.slug, c]));

  for (const g of meshSites(snap)) {
    const subject = { kind: "site" as const, id: g.id };
    const conf = bundle.gateways[g.gateway.id]?.files["wireguard.conf"];
    if (!conf) {
      out.push(err("missing-config", `no generated WireGuard config for ${g.name}`, subject));
      continue;
    }
    const seen = new Map<string, string>();
    for (const peer of parsePeers(conf)) {
      const label = peer.comment ?? "?";
      const owner = `${g.name} peer "${label}"`;
      checkPrefixes(owner, peer.allowedIps, subject);
      for (const ip of peer.allowedIps) {
        const prev = seen.get(ip);
        if (prev) out.push(err("duplicate-prefix", `${g.name}: ${ip} appears on peers "${prev}" and "${label}"`, subject));
        seen.set(ip, label);
      }

      let expected: string[];
      if (label.startsWith("client:")) {
        const c = clientBySlug.get(label.slice("client:".length).trim());
        if (!c) {
          out.push(err("unknown-peer", `${owner}: no such client`, subject));
          continue;
        }
        if (!clientEntrySites(snap, c).some((e) => e.id === g.id)) out.push(err("wrong-peer", `${owner}: this gateway is not an entry point for the client`, subject));
        expected = [`${c.tunnelIp}/32`];
      } else if (label.startsWith("site:")) {
        const p = siteBySlug.get(label.slice("site:".length).trim());
        if (!p) {
          out.push(err("unknown-peer", `${owner}: no such site`, subject));
          continue;
        }
        if (!arePeered(snap, g.id, p.id)) {
          out.push(err("wrong-peer", `${owner}: these sites should not peer directly`, subject));
          continue;
        }
        expected = gatewayPeerAllowedIps(snap, g, p);
      } else {
        out.push(err("unknown-peer", `${owner}: unlabelled peer`, subject));
        continue;
      }
      const got = [...peer.allowedIps].sort().join(",");
      const want = [...expected].sort().join(",");
      if (got !== want) out.push(err("allowedips-mismatch", `${owner}: AllowedIPs [${peer.allowedIps.join(", ")}] differs from expected [${expected.join(", ")}]`, subject));
    }
  }

  for (const c of activeClients(snap)) {
    const subject = { kind: "client" as const, id: c.id };
    const conf = bundle.clients[c.id]?.conf;
    if (!conf) {
      out.push(err("missing-config", `no generated config for client ${c.name}`, subject));
      continue;
    }
    const seen = new Map<string, string>();
    for (const peer of parsePeers(conf)) {
      const owner = `client ${c.name} peer "${peer.comment ?? "?"}"`;
      checkPrefixes(owner, peer.allowedIps, subject);
      for (const ip of peer.allowedIps) {
        const prev = seen.get(ip);
        if (prev) out.push(err("duplicate-prefix", `${c.name}: ${ip} appears on peers "${prev}" and "${peer.comment}"`, subject));
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
            out.push(err("nat", `${g.name} ${name}:${i + 1}: NAT rule present on a site that is not in masquerade layout`, { kind: "site", id: g.id }));
          }
        }
      }
    }
  }
  return out;
}

export function validateMtu(snap: Snapshot): Finding[] {
  const out: Finding[] = [];
  const all = [
    { id: "settings", name: "default", mtu: snap.settings.mtu, subject: { kind: "settings" as const, id: "settings" } },
    ...meshSites(snap).map((s) => ({ id: s.id, name: s.name, mtu: mtuOf(snap, s), subject: { kind: "site" as const, id: s.id } })),
  ];
  for (const { name, mtu, subject } of all) {
    if (mtu < 1280 || mtu > 1500) out.push(err("mtu-range", `${name}: MTU ${mtu} is outside 1280–1500`, subject));
    else if (mtu > 1420) out.push(warn("mtu-high", `${name}: MTU ${mtu} exceeds 1420 — WireGuard overhead will not fit a 1500-byte WAN; large transfers may stall`, subject));
  }
  return out;
}

export function validateTopology(snap: Snapshot): Finding[] {
  const out: Finding[] = [];
  const name = (id: string) => meshSite(snap, id).name;
  for (const e of connectivityMatrix(snap)) {
    if (e.status.kind === "unreachable") {
      out.push(err("unreachable-pair", `${name(e.a)} and ${name(e.b)} cannot connect: neither accepts incoming connections and no site does — open a UDP port at one of your sites`, { kind: "site", id: e.b }));
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
