/**
 * Roaming clients and one-time invite links.
 *
 * Keys are generated here and the private key is sealed with the server
 * secret so a QR code can be re-shown later. "Rotate" replaces the pair.
 * An unused invite link is a copy of the private key waiting to be
 * collected, so anything that retires the key or the client cancels it.
 */
import { and, asc, desc, eq, gt, gte, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, invites, sites, type ClientRow } from "@/db/schema";
import { isValidIpv4, nextFreeIp } from "@/core/ip";
import { generateKeyPair, open, randomId, randomToken, seal, sha256Hex } from "@/core/crypto";
import { SLUG_RE, slugify } from "@/core/model";
import { gateways } from "@/db/schema";
import { env, now } from "./env";
import { logEvent } from "./events";
import { HANDSHAKE_SKEW_MS } from "./live";
import { bumpConfigVersion, getSettings } from "./settings";

export class ClientError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export interface ClientInput {
  name: string;
  slug?: string;
  owner?: string;
  notes?: string;
  enabled?: boolean;
  expiresAt?: number | null;
  preferredSiteId?: string | null;
  allowedSiteIds?: string[] | null;
  allowInbound?: boolean;
  tunnelIp?: string;
}

function validate(input: Partial<ClientInput>, isCreate: boolean): void {
  if (isCreate || input.name !== undefined) {
    if (!input.name || input.name.trim().length === 0 || input.name.length > 80) throw new ClientError("name is required (max 80 chars)");
    if (/[\u0000-\u001f\u007f]/.test(input.name)) throw new ClientError("name may not contain control characters");
  }
  if (input.slug !== undefined && !SLUG_RE.test(input.slug)) throw new ClientError("slug must be lowercase letters, digits and hyphens");
  if (input.owner !== undefined && input.owner.length > 120) throw new ClientError("owner is too long");
  if (input.expiresAt != null && (!Number.isFinite(input.expiresAt) || input.expiresAt < 0)) throw new ClientError("bad expiry");
  const siteIds = new Set(getDb().select({ id: sites.id }).from(sites).all().map((r) => r.id));
  if (input.preferredSiteId && !siteIds.has(input.preferredSiteId)) throw new ClientError("preferred site does not exist");
  if (input.allowedSiteIds) {
    if (input.allowedSiteIds.length === 0) throw new ClientError("allowed sites must list at least one site, or be unrestricted");
    for (const id of input.allowedSiteIds) if (!siteIds.has(id)) throw new ClientError(`allowed site "${id}" does not exist`);
  }
  if (input.tunnelIp !== undefined && !isValidIpv4(input.tunnelIp)) throw new ClientError("address must be an IPv4 address");
}

function uniqueSlug(base: string, exceptId?: string): string {
  const taken = new Set(
    getDb()
      .select({ slug: clients.slug, id: clients.id })
      .from(clients)
      .all()
      .filter((r) => r.id !== exceptId)
      .map((r) => r.slug),
  );
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base.slice(0, 28)}-${i}`;
  return slug;
}

export function listClients(): ClientRow[] {
  return getDb().select().from(clients).orderBy(asc(clients.name)).all();
}

export function getClient(id: string): ClientRow | null {
  return getDb().select().from(clients).where(eq(clients.id, id)).get() ?? null;
}

export function createClient(input: ClientInput, actor = "admin"): ClientRow {
  validate(input, true);
  const s = getSettings();
  const db = getDb();
  const used = [
    ...db.select({ ip: clients.tunnelIp }).from(clients).all().map((r) => r.ip),
    ...db.select({ ip: gateways.tunnelIp }).from(gateways).all().map((r) => r.ip),
  ];
  const tunnelIp = input.tunnelIp ?? nextFreeIp(s.clientCidr, used, 0);
  if (!tunnelIp) throw new ClientError("client address range is full", 409);
  if (used.includes(tunnelIp)) throw new ClientError(`address ${tunnelIp} is already in use`, 409);
  const kp = generateKeyPair();
  const id = randomId();
  db.insert(clients)
    .values({
      id,
      name: input.name.trim(),
      slug: uniqueSlug(input.slug ?? slugify(input.name)),
      owner: input.owner ?? "",
      notes: input.notes ?? "",
      tunnelIp,
      publicKey: kp.publicKey,
      privateKeyEnc: seal(kp.privateKey, env().secret, "client-key"),
      pskEnc: null,
      enabled: input.enabled ?? true,
      expiresAt: input.expiresAt ?? null,
      preferredSiteId: input.preferredSiteId ?? null,
      allowedSiteIds: input.allowedSiteIds ?? null,
      allowInbound: input.allowInbound ?? false,
      createdAt: now(),
      lastHandshakeAt: null,
    })
    .run();
  bumpConfigVersion();
  logEvent("client", `Client "${input.name.trim()}" created (${tunnelIp})`, { actor, subject: id });
  return getClient(id)!;
}

export function updateClient(id: string, patch: Partial<ClientInput>, actor = "admin"): ClientRow {
  const c = getClient(id);
  if (!c) throw new ClientError("client not found", 404);
  validate(patch, false);
  const enabled = patch.enabled ?? c.enabled;
  const db = getDb();
  db.transaction((tx) => {
    tx.update(clients)
      .set({
        name: patch.name !== undefined ? patch.name.trim() : c.name,
        slug: patch.slug !== undefined && patch.slug !== c.slug ? uniqueSlug(patch.slug, id) : c.slug,
        owner: patch.owner ?? c.owner,
        notes: patch.notes ?? c.notes,
        enabled,
        expiresAt: patch.expiresAt === undefined ? c.expiresAt : patch.expiresAt,
        preferredSiteId: patch.preferredSiteId === undefined ? c.preferredSiteId : patch.preferredSiteId,
        allowedSiteIds: patch.allowedSiteIds === undefined ? c.allowedSiteIds : patch.allowedSiteIds,
        allowInbound: patch.allowInbound ?? c.allowInbound,
      })
      .where(eq(clients.id, id))
      .run();
    if (!enabled) deleteUnusedInvites(tx, id);
  });
  bumpConfigVersion();
  logEvent("client", `Client "${c.name}" updated`, { actor, subject: id, detail: patch });
  return getClient(id)!;
}

export function rotateClientKeys(id: string, actor = "admin"): ClientRow {
  const c = getClient(id);
  if (!c) throw new ClientError("client not found", 404);
  const kp = generateKeyPair();
  // In one step, so no link can be collected between the two and hand out the new key.
  getDb().transaction((tx) => {
    tx.update(clients)
      .set({ publicKey: kp.publicKey, privateKeyEnc: seal(kp.privateKey, env().secret, "client-key") })
      .where(eq(clients.id, id))
      .run();
    deleteUnusedInvites(tx, id);
  });
  bumpConfigVersion();
  logEvent("client", `Keys rotated for "${c.name}" — previous config and unused invite links no longer work`, { actor, subject: id });
  return getClient(id)!;
}

export function deleteClient(id: string, actor = "admin"): void {
  const c = getClient(id);
  if (!c) throw new ClientError("client not found", 404);
  getDb().transaction((tx) => {
    deleteUnusedInvites(tx, id);
    tx.delete(clients).where(eq(clients.id, id)).run();
  });
  bumpConfigVersion();
  logEvent("client", `Client "${c.name}" deleted`, { actor, subject: id });
}

export function clientPrivateKey(c: ClientRow): string {
  return open(c.privateKeyEnc, env().secret, "client-key");
}

/** Disable clients whose expiry has passed. Returns how many changed. */
export function expireClients(): number {
  const t = now();
  const due = getDb()
    .select()
    .from(clients)
    .where(and(eq(clients.enabled, true), gt(clients.expiresAt, 0)))
    .all()
    .filter((c) => c.expiresAt !== null && c.expiresAt <= t);
  for (const c of due) {
    getDb().transaction((tx) => {
      tx.update(clients).set({ enabled: false }).where(eq(clients.id, c.id)).run();
      deleteUnusedInvites(tx, c.id);
    });
    logEvent("client", `Client "${c.name}" expired and was disabled`, { subject: c.id });
  }
  if (due.length > 0) bumpConfigVersion();
  return due.length;
}

export function recordClientHandshake(publicKey: string, at: number): void {
  const t = now();
  if (at > t + HANDSHAKE_SKEW_MS) return;
  const c = getDb().select().from(clients).where(eq(clients.publicKey, publicKey)).get();
  if (!c) return;
  // A future value stored before this check existed must not block real ones.
  const last = c.lastHandshakeAt !== null && c.lastHandshakeAt <= t + HANDSHAKE_SKEW_MS ? c.lastHandshakeAt : null;
  if (last !== null && at - last < 60_000) return;
  getDb().update(clients).set({ lastHandshakeAt: at }).where(eq(clients.id, c.id)).run();
}

// ---------------------------------------------------------------------------
// Invites: one-time links that show the config/QR once.

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

function deleteUnusedInvites(tx: Tx, clientId: string): number {
  return tx
    .delete(invites)
    .where(and(eq(invites.clientId, clientId), isNull(invites.usedAt)))
    .run().changes;
}

/** A new link replaces the client's unused ones: one device, one link. */
export function createInvite(clientId: string, ttlMs = INVITE_TTL_MS, actor = "admin"): { token: string; expiresAt: number } {
  const c = getClient(clientId);
  if (!c) throw new ClientError("client not found", 404);
  if (!c.enabled) throw new ClientError("client is disabled", 409);
  const token = randomToken();
  const expiresAt = now() + ttlMs;
  let replaced = 0;
  getDb().transaction((tx) => {
    replaced = deleteUnusedInvites(tx, clientId);
    tx.insert(invites).values({ id: randomId(), clientId, tokenHash: sha256Hex(token), expiresAt, usedAt: null, createdAt: now() }).run();
  });
  logEvent("invite", `Invite link issued for "${c.name}"${replaced > 0 ? " (the earlier unused link no longer works)" : ""}`, { actor, subject: clientId });
  return { token, expiresAt };
}

/** Cancel a client's unused links. Returns how many there were. */
export function revokeInvites(clientId: string, actor = "admin"): number {
  const c = getClient(clientId);
  if (!c) throw new ClientError("client not found", 404);
  const n = getDb().transaction((tx) => deleteUnusedInvites(tx, clientId));
  if (n > 0) logEvent("invite", `Invite link for "${c.name}" cancelled`, { actor, subject: clientId });
  return n;
}

/** The client's link that can still be collected, if any (its token is not stored, only when it expires). */
export function pendingInvite(clientId: string): { createdAt: number; expiresAt: number } | null {
  const inv = getDb()
    .select({ createdAt: invites.createdAt, expiresAt: invites.expiresAt })
    .from(invites)
    .where(and(eq(invites.clientId, clientId), isNull(invites.usedAt), gte(invites.expiresAt, now())))
    .orderBy(desc(invites.createdAt))
    .get();
  return inv ?? null;
}

/** Look up (without consuming) an invite. */
export function peekInvite(token: string): { client: ClientRow } | { error: "invalid" | "expired" | "used" } {
  const inv = getDb().select().from(invites).where(eq(invites.tokenHash, sha256Hex(token))).get();
  if (!inv) return { error: "invalid" };
  if (inv.usedAt !== null) return { error: "used" };
  if (now() > inv.expiresAt) return { error: "expired" };
  const client = getClient(inv.clientId);
  if (!client || !client.enabled) return { error: "invalid" };
  return { client };
}

/**
 * Consume an invite: marks it used so the link cannot be replayed. The
 * caller builds the config first; since rotating or disabling deletes the
 * link, a successful consume means that config is still the client's.
 */
export function consumeInvite(token: string): { client: ClientRow } | { error: "invalid" | "expired" | "used" } {
  const r = peekInvite(token);
  if ("error" in r) return r;
  const changed = getDb()
    .update(invites)
    .set({ usedAt: now() })
    .where(and(eq(invites.tokenHash, sha256Hex(token)), eq(invites.clientId, r.client.id), isNull(invites.usedAt), gte(invites.expiresAt, now())))
    .run().changes;
  if (changed !== 1) return { error: "used" };
  logEvent("invite", `Invite link used for "${r.client.name}"`, { actor: "invite", subject: r.client.id });
  return r;
}

export function pruneInvites(): number {
  return getDb().$client.prepare("DELETE FROM invites WHERE expires_at < ? OR used_at IS NOT NULL").run(now() - 7 * 24 * 3600 * 1000).changes;
}
