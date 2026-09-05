/**
 * UniFi links: one per site, credentials sealed at rest, synced on demand,
 * on topology changes and on a timer.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { unifiLinks, type UnifiLinkRow } from "@/db/schema";
import { open, randomId, seal } from "@/core/crypto";
import { env, now } from "../env";
import { logEvent } from "../events";
import { getSettings } from "../settings";
import { getSite } from "../sites";
import { getGenerated } from "../snapshot";
import { fetchConsoleCertificate, UnifiClient, UnifiError, type ConsoleCertificate, type UnifiAuth } from "./client";
import { removeAll, syncSite, type ManagedIds, type SyncResult } from "./reconcile";

export interface LinkInput {
  baseUrl: string;
  unifiSite: string;
  auth: UnifiAuth;
  standalone?: boolean;
  /** Fingerprint the admin confirmed (required unless the certificate is system-trusted). */
  certFingerprint: string | null;
  certPem: string | null;
}

interface Secret {
  auth: UnifiAuth;
  certPem: string | null;
  standalone: boolean;
}

export class UnifiLinkError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

function normaliseUrl(u: string): string {
  let s = u.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== "https:" && !env().insecureHttp) throw new UnifiLinkError("console URL must use https://");
    return parsed.origin;
  } catch (e) {
    if (e instanceof UnifiLinkError) throw e;
    throw new UnifiLinkError("console URL is not valid");
  }
}

function unseal(row: UnifiLinkRow): Secret {
  return JSON.parse(open(row.secretEnc, env().secret, "unifi")) as Secret;
}

export function getLink(siteId: string): UnifiLinkRow | null {
  return getDb().select().from(unifiLinks).where(eq(unifiLinks.siteId, siteId)).get() ?? null;
}

export function listLinks(): UnifiLinkRow[] {
  return getDb().select().from(unifiLinks).all();
}

/** Public view: never the secret. */
export function linkView(row: UnifiLinkRow) {
  const secret = unseal(row);
  return {
    baseUrl: row.baseUrl,
    unifiSite: row.unifiSite,
    authKind: row.authKind,
    username: secret.auth.kind === "password" ? secret.auth.username : null,
    standalone: secret.standalone,
    certFingerprint: row.certFingerprint,
    enabled: row.enabled,
    lastSyncAt: row.lastSyncAt,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncDetail: row.lastSyncDetail,
    managed: row.managedIds as unknown as ManagedIds,
  };
}

export type LinkView = ReturnType<typeof linkView>;

/** Step 1 of linking: reach the console, report its certificate and identity. */
export async function probeConsole(input: { baseUrl: string; unifiSite: string; auth: UnifiAuth; standalone?: boolean; trustFingerprint?: string | null }): Promise<{ certificate: ConsoleCertificate | null; identity: { name?: string; version?: string } | null; error: string | null }> {
  const baseUrl = normaliseUrl(input.baseUrl);
  let certificate: ConsoleCertificate | null = null;
  if (baseUrl.startsWith("https://")) {
    certificate = await fetchConsoleCertificate(baseUrl);
  }
  // Credentials are only sent once the certificate is trusted (system or confirmed).
  const trusted = !certificate || certificate.systemTrusted || (input.trustFingerprint && input.trustFingerprint.toLowerCase() === certificate.fingerprint);
  if (!trusted) return { certificate, identity: null, error: null };
  const client = new UnifiClient({
    baseUrl,
    site: input.unifiSite || "default",
    auth: input.auth,
    standalone: input.standalone,
    pin: certificate && !certificate.systemTrusted ? { fingerprint: certificate.fingerprint, pem: certificate.pem } : null,
  });
  try {
    await client.login();
    const identity = await client.whoami();
    return { certificate, identity, error: null };
  } catch (e) {
    return { certificate, identity: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function saveLink(siteId: string, input: LinkInput, actor = "admin"): UnifiLinkRow {
  const site = getSite(siteId);
  if (!site) throw new UnifiLinkError("site not found", 404);
  const baseUrl = normaliseUrl(input.baseUrl);
  if (input.auth.kind === "api_key" && !input.auth.apiKey) throw new UnifiLinkError("API key is required");
  if (input.auth.kind === "password" && (!input.auth.username || !input.auth.password)) throw new UnifiLinkError("username and password are required");
  if (baseUrl.startsWith("https://") && !input.certFingerprint && !input.certPem) throw new UnifiLinkError("confirm the console certificate first");
  const secret: Secret = { auth: input.auth, certPem: input.certPem, standalone: input.standalone ?? false };
  const existing = getLink(siteId);
  const values = {
    baseUrl,
    unifiSite: input.unifiSite || "default",
    authKind: input.auth.kind,
    secretEnc: seal(JSON.stringify(secret), env().secret, "unifi"),
    certFingerprint: input.certFingerprint,
    enabled: true,
    lastSyncStatus: "never",
    lastSyncDetail: "",
  };
  if (existing) {
    getDb()
      .update(unifiLinks)
      .set(values)
      .where(eq(unifiLinks.id, existing.id))
      .run();
  } else {
    getDb()
      .insert(unifiLinks)
      .values({ id: randomId(), siteId, managedIds: { routes: {} }, lastSyncAt: null, ...values })
      .run();
  }
  logEvent("unifi", `UniFi console ${baseUrl} linked to "${site.name}"`, { actor, subject: siteId });
  return getLink(siteId)!;
}

export async function unlink(siteId: string, removeObjects: boolean, actor = "admin"): Promise<{ deleted: number; warnings: string[] }> {
  const row = getLink(siteId);
  if (!row) throw new UnifiLinkError("this site is not linked to a console", 404);
  let out = { deleted: 0, warnings: [] as string[] };
  if (removeObjects) {
    try {
      const client = clientFor(row);
      await client.login();
      out = await removeAll(client, row.managedIds as unknown as ManagedIds);
    } catch (e) {
      out.warnings.push(e instanceof Error ? e.message : String(e));
    }
  }
  getDb().delete(unifiLinks).where(eq(unifiLinks.id, row.id)).run();
  logEvent("unifi", `UniFi console unlinked from site (${removeObjects ? `${out.deleted} objects removed` : "objects left in place"})`, { actor, subject: siteId });
  return out;
}

function clientFor(row: UnifiLinkRow): UnifiClient {
  const secret = unseal(row);
  return new UnifiClient({
    baseUrl: row.baseUrl,
    site: row.unifiSite,
    auth: secret.auth,
    standalone: secret.standalone,
    pin: row.certFingerprint && secret.certPem ? { fingerprint: row.certFingerprint, pem: secret.certPem } : null,
  });
}

/** Sync one site now. Records the outcome on the link and in the event log. */
export async function syncLink(siteId: string, actor = "system"): Promise<SyncResult> {
  const row = getLink(siteId);
  if (!row) throw new UnifiLinkError("this site is not linked to a console", 404);
  const site = getSite(siteId);
  const plan = getGenerated().bundle.routers[siteId];
  if (!site || !plan) throw new UnifiLinkError("this site has no active gateway yet, so there is nothing to push", 409);
  const started = now();
  try {
    const client = clientFor(row);
    await client.login();
    const result = await syncSite(client, plan, row.managedIds as unknown as ManagedIds);
    const changes = result.created + result.updated + result.deleted;
    const status = result.warnings.length > 0 ? "warning" : "ok";
    const detail = [
      changes === 0 ? `${result.unchanged} route${result.unchanged === 1 ? "" : "s"} in sync` : `${result.created} created, ${result.updated} updated, ${result.deleted} deleted`,
      result.policy !== "n/a" ? `firewall policy ${result.policy}` : null,
      ...result.warnings,
    ]
      .filter(Boolean)
      .join(". ");
    getDb()
      .update(unifiLinks)
      .set({ managedIds: result.managed, lastSyncAt: started, lastSyncStatus: status, lastSyncDetail: detail })
      .where(eq(unifiLinks.id, row.id))
      .run();
    if (changes > 0 || result.warnings.length > 0) logEvent("unifi", `UniFi sync for "${site.name}": ${detail}`, { actor, subject: siteId });
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    getDb().update(unifiLinks).set({ lastSyncAt: started, lastSyncStatus: "error", lastSyncDetail: msg }).where(eq(unifiLinks.id, row.id)).run();
    logEvent("unifi", `UniFi sync for "${site.name}" failed: ${msg}`, { actor, subject: siteId });
    throw e instanceof UnifiError ? new UnifiLinkError(msg, 502) : e;
  }
}

const g = globalThis as unknown as { __opnmeshUnifiVersion?: number; __opnmeshUnifiLast?: number };

/**
 * Background: sync every enabled link when the topology changed since the
 * last pass, or at least every ten minutes.
 */
export async function syncDueLinks(): Promise<void> {
  const version = getSettings().configVersion;
  const t = now();
  const due = g.__opnmeshUnifiVersion !== version || t - (g.__opnmeshUnifiLast ?? 0) > 10 * 60_000;
  if (!due) return;
  g.__opnmeshUnifiVersion = version;
  g.__opnmeshUnifiLast = t;
  for (const row of listLinks()) {
    if (!row.enabled) continue;
    try {
      await syncLink(row.siteId);
    } catch {
      /* recorded on the link */
    }
  }
}
