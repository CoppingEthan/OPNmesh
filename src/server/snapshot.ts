/**
 * Read the database into a core Snapshot, generate the bundle, and cache it
 * by config version. Everything downstream (agent config, client configs,
 * router pages, validation findings) comes from here.
 */
import type { ClientSnapshot, SiteSnapshot, Snapshot } from "@/core/model";
import { generateAll, type Bundle } from "@/core/generate";
import { validateAll, type Finding } from "@/core/validate";
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

export interface Generated {
  version: number;
  snapshot: Snapshot;
  bundle: Bundle;
  findings: Finding[];
}

const g = globalThis as unknown as { __opnmeshGenerated?: Generated };

/** The current generated state, recomputed only when the config version changes. */
export function getGenerated(): Generated {
  const version = getSettings().configVersion;
  const cached = g.__opnmeshGenerated;
  if (cached && cached.version === version) return cached;
  const snapshot = loadSnapshot();
  const bundle = generateAll(snapshot);
  const findings = validateAll(snapshot, bundle);
  g.__opnmeshGenerated = { version, snapshot, bundle, findings };
  return g.__opnmeshGenerated;
}

export function invalidateGenerated(): void {
  g.__opnmeshGenerated = undefined;
}

/** A client's complete config with its real private key filled in. */
export function renderClientConf(clientId: string): string | null {
  const gen = getGenerated();
  const entry = gen.bundle.clients[clientId];
  const row = listClients().find((c) => c.id === clientId);
  if (!entry || !row) return null;
  // A config with no [Peer] cannot connect anywhere; treat it as unavailable
  // so the UI explains why instead of handing out something useless.
  if (!entry.conf.includes("[Peer]")) return null;
  return entry.conf.replace(CLIENT_PRIVATE_KEY_PLACEHOLDER, clientPrivateKey(row));
}
