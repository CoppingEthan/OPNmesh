/**
 * Semantic validators. They run on every save and every generation; errors
 * block the change, warnings surface in the UI but do not block.
 *
 * The AllowedIPs and SNAT checks deliberately re-parse the *generated text*
 * rather than trusting generator internals: a generator bug that emits a
 * subnet against the wrong peer is simultaneously a routing bug and a
 * security hole, and must be caught even if the generator's own logic agrees
 * with itself.
 */
import type { ResolvedConfig } from "../schema.js";
import type { GeneratedBundle } from "../generator/index.js";
import {
  cidrOverlaps,
  cidrHasHostBits,
  ipInCidr,
  isValidIpv4,
} from "../ip.js";
import { arePeered, connectivityMatrix, spofAnalysis } from "../topology.js";
import { gatewayPeerAllowedIps } from "../generator/wireguard.js";

export interface Finding {
  level: "error" | "warning";
  code: string;
  message: string;
}

const err = (code: string, message: string): Finding => ({ level: "error", code, message });
const warn = (code: string, message: string): Finding => ({ level: "warning", code, message });

/** Address-space sanity: overlaps, membership, uniqueness. */
export function validateAddressing(cfg: ResolvedConfig): Finding[] {
  const out: Finding[] = [];
  const { gatewaySubnet, clientSubnet } = cfg.network;

  if (cidrOverlaps(gatewaySubnet, clientSubnet)) {
    out.push(err("overlap", `gateway subnet ${gatewaySubnet} overlaps client subnet ${clientSubnet}`));
  }

  for (const s of cfg.sites) {
    for (const lan of s.lans) {
      const label = lan.name ? `${lan.cidr} (${lan.name})` : lan.cidr;
      if (cidrHasHostBits(lan.cidr)) {
        out.push(err("lan-host-bits", `site "${s.id}" network ${label} has host bits set — use the network address`));
      }
      for (const sub of [gatewaySubnet, clientSubnet]) {
        if (cidrOverlaps(lan.cidr, sub)) {
          out.push(err("overlap", `site "${s.id}" network ${label} overlaps tunnel space ${sub}`));
        }
      }
    }

    // Overlaps between VLANs at the same site: a routing ambiguity locally,
    // and it makes the generated per-site nftables set meaningless.
    for (let i = 0; i < s.lans.length; i++) {
      for (let j = i + 1; j < s.lans.length; j++) {
        const a = s.lans[i]!;
        const b = s.lans[j]!;
        if (cidrOverlaps(a.cidr, b.cidr)) {
          out.push(err("overlap", `site "${s.id}" networks ${a.cidr} and ${b.cidr} overlap each other`));
        }
      }
    }

    // The gateway's own LAN address must sit in one of its segments.
    if (!s.lans.some((l) => ipInCidr(s.gateway.lanIp, l.cidr))) {
      out.push(
        err(
          "lan-ip",
          `site "${s.id}" gateway lan_ip ${s.gateway.lanIp} is not inside any of its networks (${s.lans.map((l) => l.cidr).join(", ")})`,
        ),
      );
    }
    if (!ipInCidr(s.gateway.tunnelIp, gatewaySubnet)) {
      out.push(err("tunnel-ip", `site "${s.id}" tunnel_ip ${s.gateway.tunnelIp} is not inside ${gatewaySubnet}`));
    }
  }

  // Cross-site overlaps, every segment against every segment. Two sites
  // sharing a subnet is the classic merge-two-offices failure.
  for (let i = 0; i < cfg.sites.length; i++) {
    for (let j = i + 1; j < cfg.sites.length; j++) {
      const a = cfg.sites[i]!;
      const b = cfg.sites[j]!;
      for (const la of a.lans) {
        for (const lb of b.lans) {
          // Guest segments are never routed, so an overlap involving one is
          // harmless — and common (every office uses 192.168.1.0/24 for guests).
          if (la.role === "guest" || lb.role === "guest") continue;
          if (cidrOverlaps(la.cidr, lb.cidr)) {
            out.push(
              err("overlap", `site "${a.id}" network ${la.cidr} overlaps site "${b.id}" network ${lb.cidr}`),
            );
          }
        }
      }
    }
  }

  const tunnelIps = new Map<string, string>();
  for (const s of cfg.sites) {
    const prev = tunnelIps.get(s.gateway.tunnelIp);
    if (prev) out.push(err("dup-tunnel-ip", `tunnel_ip ${s.gateway.tunnelIp} used by both "${prev}" and "${s.id}"`));
    tunnelIps.set(s.gateway.tunnelIp, s.id);
  }
  for (const c of cfg.clients) {
    if (!ipInCidr(c.tunnelIp, clientSubnet)) {
      out.push(err("client-ip", `client "${c.id}" tunnel_ip ${c.tunnelIp} is not inside ${clientSubnet}`));
    }
    const prev = tunnelIps.get(c.tunnelIp);
    if (prev) out.push(err("dup-tunnel-ip", `tunnel_ip ${c.tunnelIp} used by both "${prev}" and "${c.id}"`));
    tunnelIps.set(c.tunnelIp, c.id);
  }

  const keys = new Map<string, string>();
  for (const owner of [
    ...cfg.sites.map((s) => ({ id: s.id, key: s.gateway.publicKey })),
    ...cfg.clients.map((c) => ({ id: c.id, key: c.publicKey })),
  ]) {
    const prev = keys.get(owner.key);
    if (prev) out.push(err("dup-key", `public key shared by "${prev}" and "${owner.id}" — every node has its own keypair`));
    keys.set(owner.key, owner.id);
  }

  return out;
}

interface ParsedPeer {
  comment: string | null;
  publicKey: string | null;
  allowedIps: string[];
}

function parsePeers(conf: string): ParsedPeer[] {
  const peers: ParsedPeer[] = [];
  let current: ParsedPeer | null = null;
  for (const raw of conf.split("\n")) {
    const line = raw.trim();
    if (line === "[Peer]") {
      current = { comment: null, publicKey: null, allowedIps: [] };
      peers.push(current);
    } else if (current) {
      if (line.startsWith("#")) current.comment ??= line.slice(1).trim();
      else if (line.startsWith("PublicKey")) current.publicKey = line.split("=").slice(1).join("=").trim();
      else if (line.startsWith("AllowedIPs")) {
        current.allowedIps = line
          .slice(line.indexOf("=") + 1)
          .split(",")
          .map((s) => s.trim());
      }
    }
  }
  return peers;
}

/**
 * AllowedIPs is a filter as well as a route. Re-parse every generated config
 * and require each peer's AllowedIPs to be *exactly* the expected set — the
 * peer's own /32 and LAN, its designated transit prefixes, and the client
 * /32s it carries. Anything extra, missing, or against the wrong peer is an
 * error, as is any default route.
 */
export function validateAllowedIps(cfg: ResolvedConfig, bundle: GeneratedBundle): Finding[] {
  const out: Finding[] = [];

  // A /0 is the obvious default route, but the danger is a near-default
  // supernet too: /1–/7 each crypto-route a huge slice of the public internet
  // (e.g. 128.0.0.0/1 is half of IPv4) into the mesh and onto every peer and
  // client. Advertised prefixes are LANs, which have no business being that
  // broad, so anything shorter than this floor is refused — closing the gap
  // where a /1 sailed past a literal "/0"-only check.
  const MIN_ADVERTISED_PREFIX = 8;
  const checkNoDefaultRoute = (owner: string, ips: string[]) => {
    for (const ip of ips) {
      const bare = ip.split("/")[0]!;
      if (!isValidIpv4(bare)) {
        out.push(err("allowedips-parse", `${owner}: unparseable AllowedIPs entry "${ip}"`));
        continue;
      }
      const prefix = ip.includes("/") ? Number(ip.split("/")[1]) : 32;
      if (ip === "0.0.0.0/0" || prefix === 0) {
        out.push(err("default-route", `${owner}: AllowedIPs contains a default route (${ip})`));
      } else if (Number.isFinite(prefix) && prefix < MIN_ADVERTISED_PREFIX) {
        out.push(
          err(
            "default-route",
            `${owner}: AllowedIPs contains a near-default supernet (${ip}); prefixes shorter than /${MIN_ADVERTISED_PREFIX} route most of the internet into the mesh`,
          ),
        );
      }
    }
  };

  for (const g of cfg.sites) {
    const conf = bundle.nodes[g.id]?.files["wg0.conf"];
    if (!conf) {
      out.push(err("missing-config", `no generated wg0.conf for gateway "${g.id}"`));
      continue;
    }
    for (const peer of parsePeers(conf)) {
      const label = peer.comment ?? "?";
      const owner = `gateway "${g.id}" peer "${label}"`;
      checkNoDefaultRoute(owner, peer.allowedIps);

      let expected: string[];
      if (label.startsWith("client:")) {
        const clientId = label.slice("client:".length).trim();
        const c = cfg.clients.find((x) => x.id === clientId);
        if (!c) {
          out.push(err("unknown-peer", `${owner}: no such client in configuration`));
          continue;
        }
        if (!c.entryPoints.includes(g.id)) {
          out.push(err("wrong-peer", `${owner}: "${g.id}" is not an entry point for this client`));
        }
        expected = [`${c.tunnelIp}/32`];
      } else {
        const p = cfg.sites.find((x) => x.id === label);
        if (!p) {
          out.push(err("unknown-peer", `${owner}: no such site in configuration`));
          continue;
        }
        if (!arePeered(cfg, g.id, p.id)) {
          out.push(err("wrong-peer", `${owner}: sites are not peered under the ${cfg.topology.shape} topology`));
          continue;
        }
        expected = gatewayPeerAllowedIps(cfg, g, p);
      }

      const got = [...peer.allowedIps].sort();
      const want = [...expected].sort();
      if (got.join(",") !== want.join(",")) {
        out.push(
          err(
            "allowedips-mismatch",
            `${owner}: AllowedIPs [${peer.allowedIps.join(", ")}] != expected [${expected.join(", ")}]`,
          ),
        );
      }
    }
  }

  for (const c of cfg.clients) {
    const conf = bundle.clients[c.id]?.config;
    if (!conf) {
      out.push(err("missing-config", `no generated config for client "${c.id}"`));
      continue;
    }
    const seen = new Map<string, string>();
    for (const peer of parsePeers(conf)) {
      const owner = `client "${c.id}" peer "${peer.comment ?? "?"}"`;
      checkNoDefaultRoute(owner, peer.allowedIps);
      for (const ip of peer.allowedIps) {
        const prev = seen.get(ip);
        if (prev) {
          out.push(err("duplicate-prefix", `client "${c.id}": ${ip} appears on peers "${prev}" and "${peer.comment}" — a prefix can live on exactly one peer`));
        }
        seen.set(ip, peer.comment ?? "?");
      }
    }
  }

  return out;
}

/** No masquerade or SNAT anywhere: source addresses must survive the mesh. */
export function validateNoSnat(bundle: GeneratedBundle): Finding[] {
  const out: Finding[] = [];
  for (const [id, node] of Object.entries(bundle.nodes)) {
    for (const [path, content] of Object.entries(node.files)) {
      for (const [i, line] of content.split("\n").entries()) {
        if (/\bmasquerade\b|\bsnat\b/i.test(line)) {
          out.push(err("snat", `node "${id}" ${path}:${i + 1}: masquerade/SNAT rule present — the mesh must preserve source addresses`));
        }
      }
    }
  }
  return out;
}

export function validateMtu(cfg: ResolvedConfig): Finding[] {
  const out: Finding[] = [];
  const all = [
    ...cfg.sites.map((s) => ({ id: `site "${s.id}"`, mtu: s.gateway.mtu })),
    ...cfg.clients.map((c) => ({ id: `client "${c.id}"`, mtu: c.mtu })),
  ];
  for (const { id, mtu } of all) {
    if (mtu < 1280 || mtu > 1500) {
      out.push(err("mtu-range", `${id}: MTU ${mtu} outside 1280–1500`));
    } else if (mtu > 1420) {
      out.push(
        warn("mtu-high", `${id}: MTU ${mtu} exceeds 1420 — WireGuard overhead will not fit a standard 1500-byte WAN MTU; large transfers may hang while ping still works`),
      );
    }
  }
  return out;
}

export function validatePorts(cfg: ResolvedConfig): Finding[] {
  const out: Finding[] = [];
  for (const s of cfg.sites) {
    if (s.gateway.listenPort < 1024) {
      out.push(
        warn("privileged-port", `site "${s.id}" listens on privileged port ${s.gateway.listenPort} — the WireGuard service needs the capability to bind it`),
      );
    }
    if (s.gateway.metricsPort === s.gateway.listenPort) {
      out.push(
        err("port-collision", `site "${s.id}": metrics_port and listen_port are both ${s.gateway.listenPort} on the same host`),
      );
    }
  }
  // Two gateways published behind the same host cannot share a port.
  const byEndpoint = new Map<string, string>();
  for (const s of cfg.sites) {
    if (s.gateway.endpoint === null) continue;
    const key = `${s.gateway.endpoint}:${s.gateway.listenPort}`;
    const prev = byEndpoint.get(key);
    if (prev) {
      out.push(err("port-collision", `sites "${prev}" and "${s.id}" both publish ${key} — same host and port cannot serve two gateways`));
    }
    byEndpoint.set(key, s.id);
  }
  return out;
}

/** Connectivity and single-point-of-failure analysis. */
export function validateTopology(cfg: ResolvedConfig): Finding[] {
  const out: Finding[] = [];

  for (const e of connectivityMatrix(cfg)) {
    if (e.status.kind === "unreachable") {
      out.push(
        err("unreachable-pair", `no path between "${e.a}" and "${e.b}" — neither has a reachable endpoint and no hub connects them; open a UDP port at one of them or use a hub topology`),
      );
    }
  }

  if (cfg.topology.shape === "single-hub") {
    const hub = cfg.topology.hubs[0]!;
    out.push(
      warn("spof", `single-hub topology: "${hub}" is a single point of failure — if it dies, ALL inter-site traffic stops`),
    );
  }

  for (const report of spofAnalysis(cfg)) {
    if (report.severedPairs.length > 0 && cfg.topology.shape !== "single-hub") {
      const pairs = report.severedPairs.map(([a, b]) => `${a} ↔ ${b}`).join(", ");
      out.push(warn("spof", `losing "${report.siteId}" severs: ${pairs}`));
    }
    for (const clientId of report.strandedClients) {
      out.push(
        warn("client-single-entry", `client "${clientId}" enters only at "${report.siteId}" — it loses everything when that gateway reboots; add a second entry point`),
      );
    }
  }

  return out;
}

/** Run everything. Errors block a save; warnings inform. */
export function runValidators(cfg: ResolvedConfig, bundle: GeneratedBundle): Finding[] {
  return [
    ...validateAddressing(cfg),
    ...validateAllowedIps(cfg, bundle),
    ...validateNoSnat(bundle),
    ...validateMtu(cfg),
    ...validatePorts(cfg),
    ...validateTopology(cfg),
  ].sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}
