/**
 * UniFi links: one per site, credentials sealed at rest, synced on demand,
 * on topology changes and on a timer.
 */
import { X509Certificate } from "node:crypto";
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

/**
 * How an https console's certificate is checked. "pinned" (the default, for
 * the self-signed certificate consoles ship with) trusts exactly the
 * certificate the admin confirmed. "system" is for a publicly trusted
 * certificate: the system CAs and the host name are checked on every
 * connection, and a renewal needs no action.
 */
export type CertMode = "pinned" | "system";

export interface LinkInput {
  baseUrl: string;
  unifiSite: string;
  auth: UnifiAuth;
  standalone?: boolean;
  certMode?: CertMode;
  /** Fingerprint and certificate the admin confirmed; required when pinned. */
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

/** One line for the server log; the detail may hold text from the remote end. */
function logFailure(what: string, e: unknown): void {
  const detail = e instanceof UnifiError ? e.detail : e instanceof Error ? e.message : String(e);
  console.error(`[opnmesh] ${what}: ${detail}`.replace(/\p{Cc}+/gu, " ").slice(0, 1000));
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
    certMode: (row.baseUrl.startsWith("https://") ? (row.certFingerprint ? "pinned" : "system") : "none") as CertMode | "none",
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
    try {
      certificate = await fetchConsoleCertificate(baseUrl);
    } catch (e) {
      logFailure(`UniFi probe of ${baseUrl} failed`, e);
      throw e;
    }
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
    logFailure(`UniFi probe of ${baseUrl} failed`, e);
    return { certificate, identity: null, error: e instanceof UnifiError ? e.message : "the console check failed" };
  }
}

/** The confirmed certificate, checked to be the one the fingerprint names. */
function checkPin(fingerprint: string | null, pem: string | null): { fingerprint: string; pem: string } {
  if (!fingerprint || !pem) throw new UnifiLinkError("confirm the console certificate first");
  let actual: string;
  try {
    actual = new X509Certificate(pem).fingerprint256.toLowerCase();
  } catch {
    throw new UnifiLinkError("the console certificate is not valid");
  }
  if (actual !== fingerprint.toLowerCase()) throw new UnifiLinkError("the console certificate does not match its fingerprint");
  return { fingerprint: actual, pem };
}

export function saveLink(siteId: string, input: LinkInput, actor = "admin"): UnifiLinkRow {
  const site = getSite(siteId);
  if (!site) throw new UnifiLinkError("site not found", 404);
  const baseUrl = normaliseUrl(input.baseUrl);
  if (input.auth.kind === "api_key" && !input.auth.apiKey) throw new UnifiLinkError("API key is required");
  if (input.auth.kind === "password" && (!input.auth.username || !input.auth.password)) throw new UnifiLinkError("username and password are required");
  let pin: { fingerprint: string; pem: string } | null = null;
  if (baseUrl.startsWith("https://")) {
    if ((input.certMode ?? "pinned") === "pinned") pin = checkPin(input.certFingerprint, input.certPem);
    else if (input.certFingerprint || input.certPem) throw new UnifiLinkError("a console checked against public CAs is not pinned; send no certificate");
  }
  const secret: Secret = { auth: input.auth, certPem: pin?.pem ?? null, standalone: input.standalone ?? false };
  const existing = getLink(siteId);
  const values = {
    baseUrl,
    unifiSite: input.unifiSite || "default",
    authKind: input.auth.kind,
    secretEnc: seal(JSON.stringify(secret), env().secret, "unifi"),
    certFingerprint: pin?.fingerprint ?? null,
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
  logEvent("unifi", `UniFi console ${baseUrl} linked to "${site.name}" (${pin ? "certificate pinned" : baseUrl.startsWith("https://") ? "public certificate" : "plain http"})`, { actor, subject: siteId });
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

function clientFor(row: UnifiLinkRow, signal?: AbortSignal): UnifiClient {
  const secret = unseal(row);
  return new UnifiClient({
    baseUrl: row.baseUrl,
    site: row.unifiSite,
    auth: secret.auth,
    standalone: secret.standalone,
    pin: row.certFingerprint && secret.certPem ? { fingerprint: row.certFingerprint, pem: secret.certPem } : null,
    signal,
  });
}

/** The most one console may take to sync, so a stuck one cannot hold up the others. */
export const LINK_SYNC_LIMIT_MS = 60_000;

/** Sync one site now. Records the outcome on the link and in the event log. */
export async function syncLink(siteId: string, actor = "system", limitMs = LINK_SYNC_LIMIT_MS): Promise<SyncResult> {
  const row = getLink(siteId);
  if (!row) throw new UnifiLinkError("this site is not linked to a console", 404);
  const site = getSite(siteId);
  const plan = getGenerated().bundle.routers[siteId];
  if (!site || !plan) throw new UnifiLinkError("this site has no active gateway yet, so there is nothing to push", 409);
  const started = now();
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // Aborting stops the request in flight; the race gives up even if something ignores that.
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new UnifiError("the console took too long, so the sync was stopped");
      abort.abort(err);
      reject(err);
    }, limitMs);
  });
  try {
    const client = clientFor(row, abort.signal);
    const work = client.login().then(() => syncSite(client, plan, row.managedIds as unknown as ManagedIds));
    const result = await Promise.race([work, expired]);
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
    logFailure(`UniFi sync for "${site.name}" (${row.baseUrl}) failed`, e);
    getDb().update(unifiLinks).set({ lastSyncAt: started, lastSyncStatus: "error", lastSyncDetail: msg }).where(eq(unifiLinks.id, row.id)).run();
    logEvent("unifi", `UniFi sync for "${site.name}" failed: ${msg}`, { actor, subject: siteId });
    throw e instanceof UnifiError ? new UnifiLinkError(msg, 502) : e;
  } finally {
    clearTimeout(timer);
  }
}

const g = globalThis as unknown as { __opnmeshUnifiVersion?: number; __opnmeshUnifiLast?: number; __opnmeshUnifiRunning?: boolean };

/**
 * Background: sync every enabled link when the topology changed since the
 * last pass, or at least every ten minutes. One pass at a time; a change made
 * during a pass is picked up by the first tick after it.
 */
export async function syncDueLinks(limitMs = LINK_SYNC_LIMIT_MS): Promise<void> {
  if (g.__opnmeshUnifiRunning) return;
  const version = getSettings().configVersion;
  const t = now();
  const due = g.__opnmeshUnifiVersion !== version || t - (g.__opnmeshUnifiLast ?? 0) > 10 * 60_000;
  if (!due) return;
  g.__opnmeshUnifiVersion = version;
  g.__opnmeshUnifiLast = t;
  g.__opnmeshUnifiRunning = true;
  try {
    for (const row of listLinks()) {
      if (!row.enabled) continue;
      try {
        await syncLink(row.siteId, "system", limitMs);
      } catch {
        /* recorded on the link */
      }
    }
  } finally {
    g.__opnmeshUnifiRunning = false;
  }
}

/** Tests: forget the last pass so the next one is due. */
export function resetUnifiScheduleForTests(): void {
  g.__opnmeshUnifiVersion = undefined;
  g.__opnmeshUnifiLast = undefined;
  g.__opnmeshUnifiRunning = false;
}
