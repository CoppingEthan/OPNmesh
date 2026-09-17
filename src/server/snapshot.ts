/**
 * Read the database into a core Snapshot, generate the bundle, and cache it
 * by config version. Everything downstream (agent config, client configs,
 * router pages, validation findings) comes from here.
 */
import type { ClientSnapshot, SiteSnapshot, Snapshot } from "@/core/model";
import { generateAll, type Bundle } from "@/core/generate";
import { heldConfigs, parsePeers, validateAll, type Finding, type Held } from "@/core/validate";
import { CLIENT_PRIVATE_KEY_PLACEHOLDER } from "@/core/generate/wireguard";
import { clientPrivateKey, listClients } from "./clients";
import { getSettings } from "./settings";
import { listSites } from "./sites";

export function loadSnapshot(): Snapshot {
  const s = getSettings();
  const sites: SiteSnapshot[] = listSites().map((site) => ({
    id: site.id,
    name: site.name,
    slug: site.slug,
    routerLayout: site.routerLayout,
    hubPriority: site.hubPriority,
    dnsServer: site.dnsServer,
    dnsDomain: site.dnsDomain,
    lans: site.lans.map((l) => ({ id: l.id, cidr: l.cidr, name: l.name, vlan: l.vlan, shared: l.shared })),
    gateway:
      site.gateway && site.gateway.status === "active"
        ? {
            id: site.gateway.id,
            publicKey: site.gateway.publicKey,
            tunnelIp: site.gateway.tunnelIp,
            lanIp: site.gateway.lanIp,
            endpointHost: site.gateway.endpointHost,
            listenPort: site.gateway.listenPort,
            mtu: site.gateway.mtu,
          }
        : null,
  }));
  const clients: ClientSnapshot[] = listClients().map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    tunnelIp: c.tunnelIp,
    publicKey: c.publicKey,
    enabled: c.enabled,
    preferredSiteId: c.preferredSiteId,
    allowedSiteIds: c.allowedSiteIds,
    allowInbound: c.allowInbound,
  }));
  return {
    settings: {
      name: s.networkName,
      gatewayCidr: s.gatewayCidr,
      clientCidr: s.clientCidr,
      listenPort: s.listenPort,
      mtu: s.mtu,
      keepalive: s.keepalive,
      interfaceName: s.interfaceName,
      privateKeyPath: "/etc/opnmesh/private.key",
    },
    sites,
    clients,
  };
}

/** What a gateway's own configuration lets it report: its peers' keys and its counters' names. */
export interface Reportable {
  peers: Set<string>;
  counters: Set<string>;
}

export interface Generated {
  version: number;
  snapshot: Snapshot;
  bundle: Bundle;
  findings: Finding[];
  /** Configs an error finding keeps from being handed out. */
  held: Held;
  /** gateway id → what its telemetry may contain. */
  reportable: Record<string, Reportable>;
}

const g = globalThis as unknown as { __opnmeshGenerated?: Generated };

const COUNTER_RE = /^\s*counter (\S+) \{\}$/gm;

/**
 * Read from the generated text itself, like the validators, so telemetry is
 * judged against exactly what the gateway was told to run.
 */
function reportableFrom(bundle: Bundle): Record<string, Reportable> {
  const out: Record<string, Reportable> = {};
  for (const [id, gw] of Object.entries(bundle.gateways)) {
    out[id] = {
      peers: new Set(parsePeers(gw.files["wireguard.conf"]).flatMap((p) => (p.publicKey ? [p.publicKey] : []))),
      counters: new Set([...gw.files["nftables.conf"].matchAll(COUNTER_RE)].map((m) => m[1]!)),
    };
  }
  return out;
}

/** The current generated state, recomputed only when the config version changes. */
export function getGenerated(): Generated {
  const version = getSettings().configVersion;
  const cached = g.__opnmeshGenerated;
  if (cached && cached.version === version) return cached;
  const snapshot = loadSnapshot();
  const bundle = generateAll(snapshot);
  const findings = validateAll(snapshot, bundle);
  g.__opnmeshGenerated = { version, snapshot, bundle, findings, held: heldConfigs(snapshot, findings), reportable: reportableFrom(bundle) };
  return g.__opnmeshGenerated;
}

export function invalidateGenerated(): void {
  g.__opnmeshGenerated = undefined;
}

/** Why a gateway's configuration is being held back, or null when it may be served. */
export function gatewayConfHeld(gatewayId: string): string | null {
  return getGenerated().held.gateways[gatewayId] ?? null;
}

/** Why a client's configuration is being held back, or null when it may be handed out. */
export function clientConfHeld(clientId: string): string | null {
  return getGenerated().held.clients[clientId] ?? null;
}

/** A client's complete config with its real private key filled in. Null when unavailable or held. */
export function renderClientConf(clientId: string): string | null {
  const gen = getGenerated();
  const entry = gen.bundle.clients[clientId];
  const row = listClients().find((c) => c.id === clientId);
  if (!entry || !row || gen.held.clients[clientId] !== undefined) return null;
  // A config with no [Peer] cannot connect anywhere; treat it as unavailable
  // so the UI explains why instead of handing out something useless.
  if (!entry.conf.includes("[Peer]")) return null;
  return entry.conf.replace(CLIENT_PRIVATE_KEY_PLACEHOLDER, clientPrivateKey(row));
}
