/**
 * Sites, their LANs, their gateway, and enrolment tokens.
 *
 * Every mutation that changes generated output bumps the config version so
 * agents pick it up on their next tick, and writes an audit event.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, enrolTokens, gateways, lans, sites, type GatewayRow, type LanRow, type SiteRow } from "@/db/schema";
import { cidrHasHostBits, isHostname, isUsableHostIp, isValidCidr, isValidIpv4, nextFreeIp, normalizeCidr } from "@/core/ip";
import { randomId, randomToken, sha256Hex } from "@/core/crypto";
import { SLUG_RE, WG_KEY_RE, slugify, type RouterLayout } from "@/core/model";
import { logEvent } from "./events";
import { now } from "./env";
import { liveState } from "./live";
import { bumpConfigVersion, getSettings } from "./settings";

export class SiteError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export interface SiteWithRelations extends SiteRow {
  lans: LanRow[];
  gateway: GatewayRow | null;
}

const LAYOUTS: RouterLayout[] = ["transit", "same_lan", "masquerade"];

export function listSites(): SiteWithRelations[] {
  const db = getDb();
  const siteRows = db.select().from(sites).orderBy(asc(sites.hubPriority), asc(sites.slug)).all();
  const lanRows = db.select().from(lans).orderBy(asc(lans.sort), asc(lans.cidr)).all();
  const gwRows = db.select().from(gateways).all();
  return siteRows.map((s) => ({
    ...s,
    lans: lanRows.filter((l) => l.siteId === s.id),
    gateway: gwRows.find((g) => g.siteId === s.id) ?? null,
  }));
}

export function getSite(id: string): SiteWithRelations | null {
  return listSites().find((s) => s.id === id) ?? null;
}

export type PublicGateway = Omit<GatewayRow, "tokenHash">;

/** A gateway row as the admin API returns it: the token hash stays in the database. */
export function publicGateway(g: GatewayRow): PublicGateway {
  const { tokenHash: _t, ...rest } = g;
  return rest;
}

export function publicSite(s: SiteWithRelations): Omit<SiteWithRelations, "gateway"> & { gateway: PublicGateway | null } {
  return { ...s, gateway: s.gateway ? publicGateway(s.gateway) : null };
}

function uniqueSlug(base: string, exceptId?: string): string {
  const taken = new Set(
    getDb()
      .select({ slug: sites.slug, id: sites.id })
      .from(sites)
      .all()
      .filter((r) => r.id !== exceptId)
      .map((r) => r.slug),
  );
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base.slice(0, 28)}-${i}`;
  return slug;
}

export interface SiteInput {
  name: string;
  slug?: string;
  notes?: string;
  routerLayout?: RouterLayout;
  hubPriority?: number;
  dnsServer?: string | null;
  dnsDomain?: string | null;
  /** Email when this site's gateway stops responding (default on). */
  alertEmail?: boolean;
}

function validateSiteInput(input: SiteInput): void {
  if (!input.name || input.name.trim().length === 0 || input.name.length > 80) throw new SiteError("name is required (max 80 chars)");
  if (/[\u0000-\u001f\u007f]/.test(input.name)) throw new SiteError("name may not contain control characters");
  if (input.slug !== undefined && !SLUG_RE.test(input.slug)) throw new SiteError("slug must be lowercase letters, digits and hyphens");
  if (input.routerLayout !== undefined && !LAYOUTS.includes(input.routerLayout)) throw new SiteError("unknown router layout");
  if (input.hubPriority !== undefined && (!Number.isInteger(input.hubPriority) || input.hubPriority < 0 || input.hubPriority > 10_000)) throw new SiteError("hub priority must be 0–10000");
  if (input.dnsServer && !isValidIpv4(input.dnsServer)) throw new SiteError("DNS server must be an IPv4 address");
  if (input.dnsDomain && !isHostname(input.dnsDomain)) throw new SiteError("DNS domain must be a hostname");
}

export function createSite(input: SiteInput, actor = "admin"): SiteWithRelations {
  validateSiteInput(input);
  const id = randomId();
  const slug = uniqueSlug(input.slug ?? slugify(input.name));
  const hubPriority = input.hubPriority ?? (getDb().select().from(sites).all().length + 1) * 10;
  getDb()
    .insert(sites)
    .values({
      id,
      name: input.name.trim(),
      slug,
      notes: input.notes ?? "",
      routerLayout: input.routerLayout ?? "transit",
      hubPriority,
      dnsServer: input.dnsServer || null,
      dnsDomain: input.dnsDomain || null,
      createdAt: now(),
      alertEmail: input.alertEmail ?? true,
    })
    .run();
  logEvent("site", `Site "${input.name.trim()}" created`, { actor, subject: id });
  return getSite(id)!;
}

export function updateSite(id: string, patch: Partial<SiteInput>, actor = "admin"): SiteWithRelations {
  const existing = getSite(id);
  if (!existing) throw new SiteError("site not found", 404);
  validateSiteInput({ name: patch.name ?? existing.name, ...patch });
  const slug = patch.slug !== undefined && patch.slug !== existing.slug ? uniqueSlug(patch.slug, id) : existing.slug;
  getDb()
    .update(sites)
    .set({
      name: (patch.name ?? existing.name).trim(),
      slug,
      notes: patch.notes ?? existing.notes,
      routerLayout: patch.routerLayout ?? existing.routerLayout,
      hubPriority: patch.hubPriority ?? existing.hubPriority,
      dnsServer: patch.dnsServer === undefined ? existing.dnsServer : patch.dnsServer || null,
      dnsDomain: patch.dnsDomain === undefined ? existing.dnsDomain : patch.dnsDomain || null,
      alertEmail: patch.alertEmail ?? existing.alertEmail,
    })
    .where(eq(sites.id, id))
    .run();
  bumpConfigVersion();
  logEvent("site", `Site "${existing.name}" updated`, { actor, subject: id, detail: patch });
  return getSite(id)!;
}

export function deleteSite(id: string, actor = "admin"): void {
  const existing = getSite(id);
  if (!existing) throw new SiteError("site not found", 404);
  getDb().delete(sites).where(eq(sites.id, id)).run();
  if (existing.gateway) liveState().forget(existing.gateway.id);
  bumpConfigVersion();
  logEvent("site", `Site "${existing.name}" deleted`, { actor, subject: id });
}

// ---------------------------------------------------------------------------
// LANs

export interface LanInput {
  cidr: string;
  name: string;
  vlan?: number | null;
  shared?: boolean;
}

function validateLan(input: LanInput): string {
  if (!isValidCidr(input.cidr)) throw new SiteError(`"${input.cidr}" is not a valid network (use e.g. 192.168.20.0/24)`);
  if (cidrHasHostBits(input.cidr)) throw new SiteError(`${input.cidr} has host bits set — use ${normalizeCidr(input.cidr)}`);
  if (!input.name || input.name.length > 60 || /[\u0000-\u001f\u007f]/.test(input.name)) throw new SiteError("network name is required (max 60 chars)");
  if (input.vlan !== undefined && input.vlan !== null && (!Number.isInteger(input.vlan) || input.vlan < 1 || input.vlan > 4094)) throw new SiteError("VLAN must be 1–4094");
  return input.cidr;
}

export function addLan(siteId: string, input: LanInput, actor = "admin"): LanRow {
  const site = getSite(siteId);
  if (!site) throw new SiteError("site not found", 404);
  const cidr = validateLan(input);
  const id = randomId();
  getDb()
    .insert(lans)
    .values({
      id,
      siteId,
      cidr,
      name: input.name.trim(),
      vlan: input.vlan ?? null,
      shared: input.shared ?? true,
      sort: site.lans.length,
    })
    .run();
  bumpConfigVersion();
  logEvent("lan", `Network ${cidr} (${input.name}) added to "${site.name}"`, { actor, subject: siteId });
  return getDb().select().from(lans).where(eq(lans.id, id)).get()!;
}

export function updateLan(siteId: string, lanId: string, patch: Partial<LanInput>, actor = "admin"): LanRow {
  const existing = getDb()
    .select()
    .from(lans)
    .where(and(eq(lans.id, lanId), eq(lans.siteId, siteId)))
    .get();
  if (!existing) throw new SiteError("network not found", 404);
  const merged: LanInput = { cidr: patch.cidr ?? existing.cidr, name: patch.name ?? existing.name, vlan: patch.vlan === undefined ? existing.vlan : patch.vlan, shared: patch.shared ?? existing.shared };
  validateLan(merged);
  getDb()
    .update(lans)
    .set({ cidr: merged.cidr, name: merged.name.trim(), vlan: merged.vlan ?? null, shared: merged.shared ?? true })
    .where(eq(lans.id, lanId))
    .run();
  bumpConfigVersion();
  logEvent("lan", `Network ${existing.cidr} updated`, { actor, subject: siteId, detail: patch });
  return getDb().select().from(lans).where(eq(lans.id, lanId)).get()!;
}

export function removeLan(siteId: string, lanId: string, actor = "admin"): void {
  const r = getDb()
    .delete(lans)
    .where(and(eq(lans.id, lanId), eq(lans.siteId, siteId)))
    .run();
  if (r.changes === 0) throw new SiteError("network not found", 404);
  bumpConfigVersion();
  logEvent("lan", `Network removed`, { actor, subject: siteId, detail: { lanId } });
}

// ---------------------------------------------------------------------------
// Enrolment tokens and gateways

export const ENROL_TOKEN_TTL_MS = 30 * 60 * 1000;

/** A site has at most one unused token: issuing a new one revokes the others. */
export function createEnrolToken(siteId: string, opts: { autoApprove?: boolean; ttlMs?: number } = {}, actor = "admin"): { token: string; expiresAt: number } {
  const site = getSite(siteId);
  if (!site) throw new SiteError("site not found", 404);
  const token = randomToken();
  const expiresAt = now() + (opts.ttlMs ?? ENROL_TOKEN_TTL_MS);
  let revoked = 0;
  getDb().transaction((tx) => {
    revoked = tx
      .delete(enrolTokens)
      .where(and(eq(enrolTokens.siteId, siteId), isNull(enrolTokens.usedAt)))
      .run().changes;
    tx.insert(enrolTokens)
      .values({
        id: randomId(),
        siteId,
        tokenHash: sha256Hex(token),
        autoApprove: opts.autoApprove ?? true,
        expiresAt,
        usedAt: null,
        createdBy: actor,
        createdAt: now(),
      })
      .run();
  });
  logEvent("enrol", `Enrolment token issued for "${site.name}"${revoked > 0 ? " (earlier unused tokens revoked)" : ""}`, { actor, subject: siteId });
  return { token, expiresAt };
}

/** Expired unused tokens go at once; used ones are kept a week for the audit trail. */
export function pruneEnrolTokens(): number {
  const t = now();
  return getDb()
    .$client.prepare("DELETE FROM enrol_tokens WHERE (used_at IS NULL AND expires_at < ?) OR (used_at IS NOT NULL AND used_at < ?)")
    .run(t, t - 7 * 24 * 3600 * 1000).changes;
}

export interface EnrolRequest {
  token: string;
  publicKey: string;
  hostname: string;
  os: string;
  arch: string;
  addresses: string[];
  agentVersion: string;
}

export type EnrolResult =
  | { ok: true; gatewayId: string; gatewayToken: string; status: "pending" | "active"; siteName: string }
  | { ok: false; reason: "invalid-token" | "expired" | "used" | "bad-key" | "duplicate-key" | "no-address" };

/** Thrown inside the enrolment transaction when another request spent the token first. */
class TokenSpent extends Error {}

function isUniqueViolation(e: unknown, column: string): boolean {
  for (let x: unknown = e; x instanceof Error; x = x.cause) {
    if ((x as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE" && x.message.includes(column)) return true;
  }
  return false;
}

/**
 * The addresses a gateway says it holds, as they are stored and shown, at
 * enrolment and from every report alike: only ones a host can hold, without
 * the prefix length telemetry sends, at most 16, and never the gateway's
 * tunnel address, which its WireGuard interface holds once configured and
 * which is shown on its own.
 */
export function hostAddresses(reported: string[], tunnelIp?: string): string[] {
  return reported
    .map((a) => a.split("/", 1)[0]!)
    .filter((ip) => isUsableHostIp(ip) && ip !== tunnelIp)
    .slice(0, 16);
}

/**
 * Consume a token and create (or replace) the site's gateway. The private key
 * never leaves the gateway; only the public key arrives here. When the site
 * already has a gateway (a rebuilt VM), its addressing and endpoint settings
 * carry over so the mesh re-forms without re-entering anything.
 */
export function enrolGateway(req: EnrolRequest): EnrolResult {
  const db = getDb();
  const t = now();
  const tok = db.select().from(enrolTokens).where(eq(enrolTokens.tokenHash, sha256Hex(req.token))).get();
  if (!tok) return { ok: false, reason: "invalid-token" };
  if (tok.usedAt !== null) return { ok: false, reason: "used" };
  if (t > tok.expiresAt) return { ok: false, reason: "expired" };
  if (!WG_KEY_RE.test(req.publicKey)) return { ok: false, reason: "bad-key" };
  const site = getSite(tok.siteId);
  if (!site) return { ok: false, reason: "invalid-token" };
  const previous = site.gateway;

  // A key is one peer's identity mesh-wide. A roaming client's key accepted
  // here would give its holder a gateway token; a rebuilt VM may keep its own.
  const keyGateway = db.select({ id: gateways.id }).from(gateways).where(eq(gateways.publicKey, req.publicKey)).get();
  const keyClient = db.select({ id: clients.id }).from(clients).where(eq(clients.publicKey, req.publicKey)).get();
  if (keyClient || (keyGateway && keyGateway.id !== previous?.id)) return { ok: false, reason: "duplicate-key" };

  // The first address becomes the router's next hop, so it must be one a host can hold.
  const addresses = hostAddresses(req.addresses, previous?.tunnelIp);
  const lanIp = previous?.lanIp ?? addresses[0];
  if (!lanIp) return { ok: false, reason: "no-address" };

  const s = getSettings();
  const used = db.select({ ip: gateways.tunnelIp }).from(gateways).all().map((r) => r.ip);
  const tunnelIp = previous?.tunnelIp ?? nextFreeIp(s.gatewayCidr, used, 0);
  if (!tunnelIp) throw new SiteError("gateway address range is full", 409);

  const gatewayToken = randomToken();
  const id = randomId();
  const status = tok.autoApprove ? "active" : "pending";
  const cleanHost = req.hostname.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 63);

  try {
    db.transaction((tx) => {
      const spent = tx
        .update(enrolTokens)
        .set({ usedAt: t })
        .where(and(eq(enrolTokens.id, tok.id), isNull(enrolTokens.usedAt)))
        .run();
      if (spent.changes !== 1) throw new TokenSpent();
      // The site's other unused tokens have nothing left to do.
      tx.delete(enrolTokens)
        .where(and(eq(enrolTokens.siteId, site.id), isNull(enrolTokens.usedAt)))
        .run();
      if (previous) tx.delete(gateways).where(eq(gateways.id, previous.id)).run();
      tx.insert(gateways)
        .values({
          id,
          siteId: site.id,
          name: previous?.name ?? `${site.name} gateway`,
          hostname: cleanHost,
          publicKey: req.publicKey,
          tunnelIp,
          lanIp,
          endpointHost: previous?.endpointHost ?? null,
          listenPort: previous?.listenPort ?? null,
          mtu: previous?.mtu ?? null,
          tokenHash: sha256Hex(gatewayToken),
          status,
          enrolledAt: t,
          approvedAt: status === "active" ? t : null,
          lastSeenAt: null,
          agentVersion: req.agentVersion.slice(0, 32),
          os: req.os.replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 64),
          arch: req.arch.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16),
          addresses,
          lastError: "",
          appliedHash: "",
          diskHash: "",
          alertState: "",
        })
        .run();
    });
  } catch (e) {
    if (e instanceof TokenSpent) return { ok: false, reason: "used" };
    // Two enrolments racing with one key: the check above cannot see the other.
    if (isUniqueViolation(e, "gateways.public_key")) return { ok: false, reason: "duplicate-key" };
    throw e;
  }
  // The old VM's numbers must not stand in for the new one's.
  if (previous) liveState().forget(previous.id);
  bumpConfigVersion();
  logEvent("gateway", `${previous ? "Replacement gateway" : "Gateway"} "${cleanHost}" enrolled for "${site.name}" (${status})`, {
    actor: "gateway",
    subject: site.id,
    detail: { publicKey: req.publicKey, addresses },
  });
  return { ok: true, gatewayId: id, gatewayToken, status, siteName: site.name };
}

export function gatewayByToken(token: string): GatewayRow | null {
  return getDb().select().from(gateways).where(eq(gateways.tokenHash, sha256Hex(token))).get() ?? null;
}

export interface GatewayPatch {
  name?: string;
  lanIp?: string;
  endpointHost?: string | null;
  listenPort?: number | null;
  mtu?: number | null;
  status?: "active" | "disabled";
}

export function updateGateway(siteId: string, patch: GatewayPatch, actor = "admin"): GatewayRow {
  const site = getSite(siteId);
  if (!site || !site.gateway) throw new SiteError("this site has no gateway", 404);
  const g = site.gateway;
  if (patch.lanIp !== undefined && !isUsableHostIp(patch.lanIp)) throw new SiteError("gateway address must be a host's IPv4 address on the site's network");
  if (patch.endpointHost) {
    if (patch.endpointHost.includes(":")) throw new SiteError("endpoint is a host only — the port is set separately");
    if (!isValidIpv4(patch.endpointHost) && !isHostname(patch.endpointHost)) throw new SiteError("endpoint must be a public IP or hostname");
  }
  if (patch.listenPort != null && (!Number.isInteger(patch.listenPort) || patch.listenPort < 1 || patch.listenPort > 65535)) throw new SiteError("port out of range");
  if (patch.mtu != null && (patch.mtu < 1280 || patch.mtu > 1500)) throw new SiteError("MTU must be 1280–1500");
  if (patch.name !== undefined && (patch.name.length === 0 || patch.name.length > 80)) throw new SiteError("name must be 1–80 chars");

  getDb()
    .update(gateways)
    .set({
      name: patch.name ?? g.name,
      lanIp: patch.lanIp ?? g.lanIp,
      endpointHost: patch.endpointHost === undefined ? g.endpointHost : patch.endpointHost || null,
      listenPort: patch.listenPort === undefined ? g.listenPort : patch.listenPort,
      mtu: patch.mtu === undefined ? g.mtu : patch.mtu,
      status: patch.status ?? (g.status === "pending" ? "pending" : g.status),
      approvedAt: patch.status === "active" && g.approvedAt === null ? now() : g.approvedAt,
    })
    .where(eq(gateways.id, g.id))
    .run();
  // A disabled gateway's last report would otherwise keep showing as current traffic.
  if (patch.status === "disabled") liveState().forget(g.id);
  bumpConfigVersion();
  logEvent("gateway", `Gateway for "${site.name}" updated`, { actor, subject: siteId, detail: patch });
  return getSite(siteId)!.gateway!;
}

export function approveGateway(siteId: string, actor = "admin"): GatewayRow {
  return updateGateway(siteId, { status: "active" }, actor);
}

export function removeGateway(siteId: string, actor = "admin"): void {
  const site = getSite(siteId);
  if (!site || !site.gateway) throw new SiteError("this site has no gateway", 404);
  getDb().delete(gateways).where(eq(gateways.id, site.gateway.id)).run();
  liveState().forget(site.gateway.id);
  bumpConfigVersion();
  logEvent("gateway", `Gateway removed from "${site.name}"`, { actor, subject: siteId });
}

/** Called on every telemetry report. Cheap: one indexed update. Addresses are passed only when they changed. */
export function recordGatewayReport(
  gatewayId: string,
  r: { agentVersion: string; appliedHash: string; diskHash: string; lastError: string; addresses?: string[] },
): void {
  getDb()
    .update(gateways)
    .set({
      lastSeenAt: now(),
      agentVersion: r.agentVersion.slice(0, 32),
      appliedHash: r.appliedHash.slice(0, 64),
      diskHash: r.diskHash.slice(0, 64),
      lastError: r.lastError.slice(0, 500),
      ...(r.addresses ? { addresses: r.addresses } : {}),
    })
    .where(eq(gateways.id, gatewayId))
    .run();
}
