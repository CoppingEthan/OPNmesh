/**
 * Health checks: quick, plain-language tests that narrow a problem down.
 *
 * Two halves. The controller checks what it can see from here: whether the
 * gateway reports, runs the current configuration, resolves by name, has a
 * handshake with every direct peer, and whether anything has managed to dial
 * in. The gateway checks what only it can see, when asked via its next
 * telemetry response: forwarding, the interface, the firewall, its own route
 * table, whether the site router really sends each remote network back to it,
 * and whether full-size packets survive the path to each peer.
 */
import { promises as dns } from "node:dns";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { gateways, type GatewayRow } from "@/db/schema";
import { formatIpv4, isHostname, parseIpv4 } from "@/core/ip";
import { endpointOf, isReachable, listenPortOf, meshSites, mtuOf, pairStatus, type MeshSite } from "@/core/topology";
import { now } from "./env";
import { logEvent } from "./events";
import { liveState } from "./live";
import { getSettings } from "./settings";
import { getSite } from "./sites";
import { getGenerated } from "./snapshot";
import { gatewayHealth } from "./status";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  title: string;
  /** What was observed, in one or two sentences. */
  detail: string;
  /** What to do about it. */
  hint?: string;
}

/** What the gateway is asked to test. Mirrored by DiagRequest in the agent. */
export interface AgentDiagRequest {
  id: string;
  listenPort: number;
  mtu: number;
  lanIp: string;
  /**
   * Everything the site router must send to this gateway. `tunnelRoute` marks
   * the networks the gateway itself routes into the tunnel (remote LANs); the
   * tunnel address ranges are not expected in its route table as a whole, since
   * roaming clients get per-client /32s and the gateway range is a connected
   * route on the interface.
   */
  remoteNets: Array<{ cidr: string; ip: string; label: string; tunnelRoute: boolean }>;
  /** Whether the site router is expected to route those networks to this gateway. */
  routerTest: boolean;
  /** Direct peers to ping with full-size packets. */
  mtuTargets: Array<{ ip: string; label: string }>;
  /** Hostnames this gateway must resolve to reach its peers. */
  endpointHosts: Array<{ host: string; label: string }>;
}

export const checkResultSchema = z.object({
  id: z.string().min(1).max(80),
  status: z.enum(["pass", "warn", "fail", "skip"]),
  title: z.string().min(1).max(200),
  detail: z.string().max(2000).default(""),
  hint: z.string().max(2000).optional(),
});

export const agentDiagReportSchema = z.object({
  id: z.string().min(1).max(40),
  ranAt: z.number().int().min(0),
  checks: z.array(checkResultSchema).max(200),
});
export type AgentDiagReport = z.infer<typeof agentDiagReportSchema>;

export interface SiteDiagnostics {
  requestedAt: number | null;
  agentAt: number | null;
  /** A run was asked for and the gateway has not answered yet. */
  pending: boolean;
  /** The last request went unanswered for two minutes. */
  agentUnanswered: boolean;
  controller: CheckResult[];
  agent: CheckResult[];
}

/** How long we wait for the gateway before calling a request unanswered. */
const AGENT_WAIT_MS = 120_000;
/** A handshake this recent means the tunnel is alive (WireGuard rekeys every two minutes). */
const FRESH_HANDSHAKE_S = 180;

/**
 * A plausible host in a network, used as the destination of test packets:
 * the first host, or the last one when the first is an address the gateway
 * itself holds. A probe to one of the gateway's own addresses would be
 * delivered locally by the kernel (the local table outranks every rule) and
 * could never reach the router, so it must be avoided.
 */
export function probeIpFor(cidr: string, avoid: string[] = []): string {
  const [addr, bitsStr] = cidr.split("/");
  const n = parseIpv4(addr ?? "") ?? 0;
  const bits = Math.min(32, Math.max(0, Number(bitsStr ?? 32)));
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const net = (n & mask) >>> 0;
  if (bits >= 31) return formatIpv4(net);
  const first = formatIpv4((net + 1) >>> 0);
  if (!avoid.includes(first)) return first;
  const broadcast = (net | (~mask >>> 0)) >>> 0;
  return formatIpv4((broadcast - 1) >>> 0);
}

/** Ask the gateway to run its checks on its next report. Null when there is no gateway. */
export function requestDiagnostics(siteId: string, actor: string): { requestedAt: number } | null {
  const site = getSite(siteId);
  if (!site?.gateway) return null;
  const t = now();
  getDb().update(gateways).set({ diagRequestedAt: t }).where(eq(gateways.id, site.gateway.id)).run();
  logEvent("gateway", `Health checks requested for ${site.name}`, { actor, subject: siteId });
  return { requestedAt: t };
}

function isPending(gw: GatewayRow, at: number): boolean {
  return gw.diagRequestedAt !== null && (gw.diagAt === null || gw.diagAt < gw.diagRequestedAt) && at - gw.diagRequestedAt < AGENT_WAIT_MS;
}

/** The request to hand a gateway with its telemetry response, if one is outstanding. */
export function pendingAgentRequest(gw: GatewayRow, at = now()): AgentDiagRequest | null {
  if (!isPending(gw, at)) return null;
  return buildAgentRequest(gw, String(gw.diagRequestedAt));
}

export function buildAgentRequest(gw: GatewayRow, id: string): AgentDiagRequest {
  const gen = getGenerated();
  const snap = gen.snapshot;
  const mine = meshSites(snap).find((s) => s.id === gw.siteId);
  const plan = gen.bundle.routers[gw.siteId];
  const req: AgentDiagRequest = {
    id,
    listenPort: mine ? listenPortOf(snap, mine) : snap.settings.listenPort,
    mtu: mine ? mtuOf(snap, mine) : snap.settings.mtu,
    lanIp: gw.lanIp,
    remoteNets: [],
    routerTest: false,
    mtuTargets: [],
    endpointHosts: [],
  };
  if (!mine) return req;
  if (plan) {
    const ranges = new Set([snap.settings.gatewayCidr, snap.settings.clientCidr]);
    const own = [gw.tunnelIp, gw.lanIp, ...gw.addresses];
    req.remoteNets = plan.routes.map((r) => ({ cidr: r.cidr, ip: probeIpFor(r.cidr, own), label: r.label, tunnelRoute: !ranges.has(r.cidr) }));
    req.routerTest = plan.layout !== "masquerade";
  }
  for (const other of meshSites(snap)) {
    if (other.id === mine.id) continue;
    if (pairStatus(snap, mine.id, other.id).kind !== "direct") continue;
    req.mtuTargets.push({ ip: other.gateway.tunnelIp, label: other.name });
    const ep = endpointOf(snap, other);
    const host = ep ? ep.slice(0, ep.lastIndexOf(":")) : null;
    if (host && isHostname(host)) req.endpointHosts.push({ host, label: other.name });
  }
  return req;
}

/** Keep the gateway's answer. Returns false for an answer to an older request. */
export function storeAgentReport(gw: GatewayRow, report: AgentDiagReport): boolean {
  if (gw.diagRequestedAt !== null && report.id !== String(gw.diagRequestedAt)) return false;
  getDb().update(gateways).set({ diagJson: JSON.stringify(report), diagAt: now() }).where(eq(gateways.id, gw.id)).run();
  return true;
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** What the controller can tell without the gateway's help. */
export async function controllerChecks(siteId: string, at = now()): Promise<CheckResult[]> {
  const site = getSite(siteId);
  if (!site) return [];
  const gw = site.gateway;
  if (!gw) return [{ id: "gateway", status: "skip", title: "No gateway installed yet", detail: "Install the gateway on a VM at this site to run checks." }];
  const settings = getSettings();
  const live = liveState();
  const lg = live.get(gw.id);
  const health = gatewayHealth(gw, lg, at, settings.telemetryIntervalS);
  const checks: CheckResult[] = [];
  const controllerUrl = settings.publicUrl ?? "the controller";

  // 1. Is the gateway talking to us?
  const seen = lg?.at ?? gw.lastSeenAt;
  switch (health) {
    case "online":
      checks.push({ id: "reporting", status: "pass", title: "Gateway is reporting", detail: `Last report ${fmtAgo(at - (seen ?? at))}.` });
      break;
    case "stale":
      checks.push({ id: "reporting", status: "warn", title: "Gateway reports are late", detail: `Last report ${fmtAgo(at - (seen ?? at))}; it normally reports every ${settings.telemetryIntervalS} s.`, hint: "The VM may be overloaded or its connection to the controller flapping. `journalctl -u opnmesh-gw` on the VM shows what the agent sees." });
      break;
    case "offline":
      checks.push({ id: "reporting", status: "fail", title: "Gateway has stopped reporting", detail: `Last report ${fmtAgo(at - (seen ?? at))}.`, hint: `Check the VM is running and can reach ${controllerUrl}. On the VM, \`systemctl status opnmesh-gw\` and \`journalctl -u opnmesh-gw\` show why.` });
      break;
    case "never":
      checks.push({ id: "reporting", status: "fail", title: "Gateway has never reported", detail: "It enrolled but no report has arrived since.", hint: "Run the install command from the Gateway panel on the VM, then check `journalctl -u opnmesh-gw`." });
      break;
    case "pending":
      checks.push({ id: "reporting", status: "skip", title: "Gateway is waiting for approval", detail: "Approve it in the Gateway panel; nothing else can be checked until then." });
      return checks;
    case "disabled":
      checks.push({ id: "reporting", status: "skip", title: "Gateway is disabled", detail: "Enable it in the Gateway panel to bring it back into the mesh." });
      return checks;
  }

  // 2. Is it running what we generated?
  const gen = getGenerated();
  const desired = gen.bundle.gateways[gw.id]?.hash ?? "";
  const applied = lg?.report.appliedHash ?? gw.appliedHash;
  const lastError = lg?.report.lastError ?? gw.lastError;
  if (lastError) {
    checks.push({ id: "config", status: "fail", title: "The last configuration change failed on the gateway", detail: lastError.slice(0, 400), hint: "Fix the cause on the VM; the agent retries on its own. `opnmesh-gw rollback` restores the previous working configuration meanwhile." });
  } else if (desired && applied === desired) {
    checks.push({ id: "config", status: "pass", title: "Configuration is current", detail: "The gateway runs exactly what the controller generated for it." });
  } else if (desired) {
    checks.push({ id: "config", status: "warn", title: "Latest configuration not applied yet", detail: "The gateway has not picked up the most recent change.", hint: "It fetches on its next report, so a few seconds is normal. If this persists, the gateway may be unable to reach the controller." });
  }
  if (lg && !lg.report.interfaceUp) {
    checks.push({ id: "interface", status: "fail", title: "Tunnel interface is down", detail: "The gateway reports that its WireGuard interface is not up.", hint: "`opnmesh-gw up` on the VM brings it up from the files on disk; `journalctl -u opnmesh-gw` shows why it went down." });
  }

  // 3. Public name.
  if (gw.endpointHost && isHostname(gw.endpointHost)) {
    try {
      const r = await dns.lookup(gw.endpointHost, { family: 4 });
      checks.push({ id: "endpoint-dns", status: "pass", title: "Public name resolves", detail: `${gw.endpointHost} → ${r.address}.` });
    } catch {
      checks.push({ id: "endpoint-dns", status: "fail", title: "Public name does not resolve", detail: `${gw.endpointHost} has no address in DNS, so nothing can dial in.`, hint: "Check the DNS record. If it is a dynamic DNS name, make sure the updater at the site is still running." });
    }
  }

  const snap = gen.snapshot;
  const all = meshSites(snap);
  const mine = all.find((s) => s.id === siteId);
  if (!mine) {
    checks.push({ id: "mesh", status: "skip", title: "Site is not in the mesh yet", detail: "The gateway must be approved and active before tunnels exist." });
    return checks;
  }
  const myPort = listenPortOf(snap, mine);
  const myEndpoint = endpointOf(snap, mine);
  const peerOf = (fromGw: string | undefined, key: string) => (fromGw ? live.get(fromGw)?.report.peers.find((p) => p.publicKey === key) : undefined);
  const hsAge = (hs: number | undefined) => (hs && hs > 0 ? Math.max(0, Math.floor(at / 1000 - hs)) : null);

  // 4. Every direct peer.
  for (const other of all) {
    if (other.id === mine.id) continue;
    const ps = pairStatus(snap, mine.id, other.id);
    if (ps.kind === "unreachable") {
      checks.push({ id: `tunnel:${other.id}`, status: "fail", title: `No possible path to ${other.name}`, detail: "Neither site accepts incoming connections and no site can relay between them.", hint: "Give one of the two sites a public address and port forward, or add a hub site that accepts connections." });
      continue;
    }
    if (ps.kind !== "direct") continue;
    const pa = peerOf(mine.gateway.id, other.gateway.publicKey);
    const pb = peerOf(other.gateway.id, mine.gateway.publicKey);
    if (!pa && !pb) {
      checks.push({ id: `tunnel:${other.id}`, status: "skip", title: `No data yet for the tunnel to ${other.name}`, detail: "Neither gateway has reported since the controller started." });
      continue;
    }
    const age = Math.min(...[hsAge(pa?.latestHandshake), hsAge(pb?.latestHandshake)].filter((x): x is number => x !== null), Infinity);
    const rtt = [pa?.rttMs, pb?.rttMs].filter((x): x is number => typeof x === "number");
    if (age < FRESH_HANDSHAKE_S && rtt.length > 0) {
      checks.push({ id: `tunnel:${other.id}`, status: "pass", title: `Tunnel to ${other.name} is up`, detail: `Handshake ${age} s ago, ${Math.min(...rtt).toFixed(1)} ms round trip.` });
    } else if (age < FRESH_HANDSHAKE_S) {
      checks.push({ id: `tunnel:${other.id}`, status: "warn", title: `Tunnel to ${other.name} handshakes but pings get no reply`, detail: "The keys and addresses are right, yet packets do not come back through the tunnel.", hint: `Run the checks at ${other.name} too: forwarding or firewall rules there are the usual cause.` });
    } else {
      const otherEndpoint = endpointOf(snap, other);
      let hint: string;
      if (isReachable(other) && !isReachable(mine)) hint = `This gateway dials ${other.name} at ${otherEndpoint}. Check that address is right and that the router there forwards UDP ${listenPortOf(snap, other)} to its gateway.`;
      else if (isReachable(mine) && !isReachable(other)) hint = `${other.name} dials this site at ${myEndpoint}. Check the router here forwards UDP ${myPort} to ${gw.lanIp} (see the inbound check below).`;
      else hint = `Either side can start this tunnel. Check both public addresses and that each router forwards its UDP port to its gateway.`;
      checks.push({ id: `tunnel:${other.id}`, status: "fail", title: `No tunnel to ${other.name}`, detail: age === Infinity ? "There has never been a handshake." : `The last handshake was ${fmtAgo(age * 1000)}.`, hint });
    }
  }

  // 5. Can anything dial in?
  if (isReachable(mine)) {
    const dialers: Array<{ name: string; key: string; gwId: string | null }> = [];
    for (const other of all) {
      if (other.id !== mine.id && !isReachable(other) && pairStatus(snap, mine.id, other.id).kind === "direct") dialers.push({ name: other.name, key: other.gateway.publicKey, gwId: other.gateway.id });
    }
    for (const c of snap.clients) if (c.enabled) dialers.push({ name: `client ${c.name}`, key: c.publicKey, gwId: null });
    const fresh = dialers.filter((d) => (hsAge(peerOf(mine.gateway.id, d.key)?.latestHandshake) ?? Infinity) < FRESH_HANDSHAKE_S);
    if (fresh.length > 0) {
      checks.push({ id: "inbound", status: "pass", title: "Accepts incoming connections", detail: `${fresh.map((d) => d.name).join(", ")} dialled in recently, so the public address and port forward work.` });
    } else if (dialers.length === 0) {
      checks.push({ id: "inbound", status: "skip", title: "Nothing dials in to this site yet", detail: "Every other site accepts connections itself and there are no clients, so inbound cannot be tested from outside." });
    } else {
      // A dialer that reaches some other site but not this one points squarely at this site's port forward.
      const elsewhere = dialers.filter((d) => {
        if (!d.gwId) return false;
        const rep = live.get(d.gwId)?.report;
        return rep?.peers.some((p) => p.publicKey !== mine.gateway.publicKey && (hsAge(p.latestHandshake) ?? Infinity) < FRESH_HANDSHAKE_S) ?? false;
      });
      const online = dialers.filter((d) => d.gwId && live.get(d.gwId));
      if (elsewhere.length > 0) {
        checks.push({ id: "inbound", status: "fail", title: "Nothing can dial in to this site", detail: `${elsewhere.map((d) => d.name).join(", ")} reach other sites but not this one.`, hint: `Check the router forwards UDP ${myPort} to ${gw.lanIp} and that ${myEndpoint} is this site's current public address.` });
      } else if (online.length > 0) {
        checks.push({ id: "inbound", status: "warn", title: "No site has dialled in yet", detail: `${online.map((d) => d.name).join(", ")} are online but have no handshake with this site.`, hint: `If this persists for more than a minute, check the router forwards UDP ${myPort} to ${gw.lanIp} and that ${myEndpoint} is right.` });
      } else {
        checks.push({ id: "inbound", status: "skip", title: "Cannot test incoming connections right now", detail: "The sites and clients that dial in to this one are all offline." });
      }
    }
  } else {
    checks.push({ id: "inbound", status: "skip", title: "Dials out only", detail: "This site has no public address, so it starts every tunnel itself and needs no port forward." });
  }
  return checks;
}

export async function siteDiagnostics(siteId: string, at = now()): Promise<SiteDiagnostics> {
  const site = getSite(siteId);
  const gw = site?.gateway ?? null;
  const controller = await controllerChecks(siteId, at);
  let agent: AgentDiagReport | null = null;
  if (gw?.diagJson) {
    try {
      agent = agentDiagReportSchema.parse(JSON.parse(gw.diagJson));
    } catch {
      agent = null;
    }
  }
  const requestedAt = gw?.diagRequestedAt ?? null;
  const agentAt = gw?.diagAt ?? null;
  const unanswered = requestedAt !== null && (agentAt === null || agentAt < requestedAt);
  return {
    requestedAt,
    agentAt,
    pending: gw ? isPending(gw, at) : false,
    agentUnanswered: unanswered && at - (requestedAt ?? at) >= AGENT_WAIT_MS,
    controller,
    agent: agent?.checks ?? [],
  };
}

/** For the sites list: the worst status among the last results, or null when never run. */
export function worstStatus(checks: CheckResult[]): CheckStatus | null {
  if (checks.length === 0) return null;
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

export type { MeshSite };
