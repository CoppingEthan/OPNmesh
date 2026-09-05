/**
 * The dashboard payload: everything a page or the live stream needs, built
 * from the database, the generated bundle and live telemetry in one call.
 * Cached for up to a second while nothing has changed, because the live
 * stream asks for it once a second per open dashboard.
 */
import type { Finding } from "@/core/validate";
import { meshSites, spofAnalysis, type SpofReport } from "@/core/topology";
import type { RouterLayout } from "@/core/model";
import { keyFingerprint } from "@/core/crypto";
import { listClients } from "./clients";
import { liveState } from "./live";
import { liveSeries, type LiveSeriesPayload } from "./live-series";
import { getSettings } from "./settings";
import { listSites } from "./sites";
import { getGenerated } from "./snapshot";
import { now } from "./env";
import {
  clientSiteRates,
  clientViews,
  desiredHashFor,
  gatewayView,
  pairRateViews,
  tunnelViews,
  type ClientSiteRateView,
  type ClientView,
  type GatewayView,
  type PairRateView,
  type TunnelView,
} from "./status";

export interface SiteState {
  id: string;
  name: string;
  slug: string;
  notes: string;
  routerLayout: RouterLayout;
  hubPriority: number;
  dnsServer: string | null;
  dnsDomain: string | null;
  alertEmail: boolean;
  lans: Array<{ id: string; cidr: string; name: string; vlan: number | null; shared: boolean }>;
  gateway: (GatewayView & {
    name: string;
    hostname: string;
    publicKey: string;
    /** Same short SHA-256 the gateway installer prints, for out-of-band comparison. */
    keyFingerprint: string;
    tunnelIp: string;
    lanIp: string;
    endpointHost: string | null;
    listenPort: number | null;
    mtu: number | null;
    status: "pending" | "active" | "disabled";
    addresses: string[];
    enrolledAt: number;
    os: string;
    arch: string;
  }) | null;
  reachable: boolean;
  inMesh: boolean;
}

export interface Headline {
  level: "ok" | "warn" | "bad" | "empty";
  title: string;
  detail: string;
}

export interface SiteRateView {
  siteId: string;
  /** Bytes per second arriving at this site's gateway over its tunnels. */
  inBps: number;
  /** Bytes per second leaving this site's gateway over its tunnels. */
  outBps: number;
}

export interface StatePayload {
  at: number;
  settings: {
    networkName: string;
    gatewayCidr: string;
    clientCidr: string;
    listenPort: number;
    mtu: number;
    keepalive: number;
    interfaceName: string;
    telemetryIntervalS: number;
    configVersion: number;
    publicUrl: string | null;
    alertsConfigured: boolean;
  };
  sites: SiteState[];
  tunnels: TunnelView[];
  pairs: PairRateView[];
  siteRates: SiteRateView[];
  clientSiteRates: ClientSiteRateView[];
  clients: ClientView[];
  findings: Finding[];
  spof: SpofReport[];
  headline: Headline;
  /** Last two minutes of per-site throughput, one sample per second. */
  liveSeries: LiveSeriesPayload;
}

const g = globalThis as unknown as { __opnmeshStateCache?: { at: number; version: number; generation: number; payload: StatePayload } };

export function buildState(at = now()): StatePayload {
  const s = getSettings();
  const live = liveState();
  const c = g.__opnmeshStateCache;
  if (c && c.version === s.configVersion && c.generation === live.generation && at - c.at < 1000 && at >= c.at) return c.payload;
  const payload = computeState(at);
  g.__opnmeshStateCache = { at, version: s.configVersion, generation: live.generation, payload };
  return payload;
}

function computeState(at: number): StatePayload {
  const s = getSettings();
  const gen = getGenerated();
  const live = liveState();
  const sites: SiteState[] = listSites().map((site) => {
    const gw = site.gateway;
    const view = gw ? gatewayView(gw, site.slug, live.get(gw.id), desiredHashFor(gen.bundle, gw.id), at, s.telemetryIntervalS) : null;
    return {
      id: site.id,
      name: site.name,
      slug: site.slug,
      notes: site.notes,
      routerLayout: site.routerLayout,
      hubPriority: site.hubPriority,
      dnsServer: site.dnsServer,
      dnsDomain: site.dnsDomain,
      alertEmail: site.alertEmail,
      lans: site.lans.map((l) => ({ id: l.id, cidr: l.cidr, name: l.name, vlan: l.vlan, shared: l.shared })),
      gateway:
        gw && view
          ? {
              ...view,
              name: gw.name,
              hostname: gw.hostname,
              publicKey: gw.publicKey,
              keyFingerprint: keyFingerprint(gw.publicKey),
              tunnelIp: gw.tunnelIp,
              lanIp: gw.lanIp,
              endpointHost: gw.endpointHost,
              listenPort: gw.listenPort,
              mtu: gw.mtu,
              status: gw.status,
              addresses: gw.addresses,
              enrolledAt: gw.enrolledAt,
              os: gw.os,
              arch: gw.arch,
            }
          : null,
      reachable: !!gw && gw.status === "active" && gw.endpointHost !== null,
      inMesh: !!gw && gw.status === "active",
    };
  });

  const siteRates: SiteRateView[] = meshSites(gen.snapshot).map((site) => {
    const l = live.get(site.gateway.id);
    let inBps = 0;
    let outBps = 0;
    if (l) {
      for (const r of l.peerRates.values()) {
        inBps += r.rxBps;
        outBps += r.txBps;
      }
    }
    return { siteId: site.id, inBps, outBps };
  });

  const tunnels = tunnelViews(gen.snapshot, live, at);
  const clients = clientViews(listClients(), gen.snapshot, live, at);
  const headline = computeHeadline(sites, tunnels, gen.findings);

  return {
    at,
    settings: {
      networkName: s.networkName,
      gatewayCidr: s.gatewayCidr,
      clientCidr: s.clientCidr,
      listenPort: s.listenPort,
      mtu: s.mtu,
      keepalive: s.keepalive,
      interfaceName: s.interfaceName,
      telemetryIntervalS: s.telemetryIntervalS,
      configVersion: s.configVersion,
      publicUrl: s.publicUrl,
      alertsConfigured: s.smtpHost !== "" && s.smtpFrom !== "" && s.alertTo.trim() !== "",
    },
    sites,
    tunnels,
    pairs: pairRateViews(gen.snapshot, live),
    siteRates,
    clientSiteRates: clientSiteRates(gen.snapshot, live),
    clients,
    findings: gen.findings,
    spof: spofAnalysis(gen.snapshot),
    headline,
    liveSeries: liveSeries().payload(),
  };
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function computeHeadline(sites: SiteState[], tunnels: TunnelView[], findings: Finding[]): Headline {
  const inMesh = sites.filter((s) => s.inMesh);
  if (sites.length === 0) return { level: "empty", title: "Add your first site", detail: "A site is a location with its own router and networks. Create one, then install a gateway there." };
  if (inMesh.length === 0) {
    return { level: "empty", title: "Waiting for your first gateway", detail: "No gateway has connected yet. Open a site and run the install command it shows you." };
  }
  const errors = findings.filter((f) => f.level === "error");
  if (errors.length > 0) return { level: "bad", title: "Your configuration has a problem", detail: errors[0]!.message };

  const offline = inMesh.filter((s) => s.gateway && (s.gateway.health === "offline" || s.gateway.health === "never"));
  if (offline.length > 0) {
    const names = list(offline.map((s) => s.name));
    return {
      level: "bad",
      title: offline.length === inMesh.length ? "No gateway is reporting" : `${names} ${offline.length === 1 ? "is" : "are"} not responding`,
      detail:
        offline.length === inMesh.length
          ? "None of your gateways has checked in recently. If the controller was just restarted, give them a minute."
          : `The other sites keep talking to each other; only traffic to and from ${offline.length === 1 ? "that site" : "those sites"} is affected.`,
    };
  }
  const attention = inMesh.filter((s) => s.gateway?.attention);
  if (attention.length > 0) {
    return { level: "warn", title: `${list(attention.map((s) => s.name))} need${attention.length === 1 ? "s" : ""} attention`, detail: attention[0]!.gateway!.attention! };
  }
  const down = tunnels.filter((t) => t.kind === "direct" && t.health === "down");
  if (down.length > 0) {
    const name = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
    return { level: "warn", title: `${down.length === 1 ? "A tunnel is" : `${down.length} tunnels are`} down`, detail: `${name(down[0]!.a)} and ${name(down[0]!.b)} are both online but have not completed a handshake. Check the port forward at whichever side accepts connections.` };
  }
  const stale = inMesh.filter((s) => s.gateway?.health === "stale");
  if (stale.length > 0) return { level: "warn", title: `${list(stale.map((s) => s.name))} ${stale.length === 1 ? "is" : "are"} slow to report`, detail: "Reports are arriving late. The tunnels may be fine; the controller link is struggling." };
  if (inMesh.length === 1) return { level: "ok", title: `${inMesh[0]!.name} is online`, detail: "Add a second site to connect them together." };
  return {
    level: "ok",
    title: "Everything is working",
    detail: `All ${inMesh.length} sites are online and every connection between them is healthy.`,
  };
}
