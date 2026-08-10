/**
 * Enrolment registry: enrolment tokens, pending nodes, and node→token
 * bindings. Framework-agnostic; the dev control server and the future
 * Next.js app both use it.
 *
 * Security properties (§12 of the brief):
 *  - Enrolment tokens are single-use, short-TTL (15 min default), role-bound.
 *  - Only token HASHES are stored, for both enrolment and node tokens.
 *  - Enrolment is human-initiated and manually approved: a pending node gets
 *    no configuration and no access until an admin approves it.
 *  - No auto-discovery: the only path to a binding is issue → enrol → approve.
 */
import { createHash, randomBytes } from "node:crypto";

export type NodeRole = "gateway" | "relay" | "client";

export interface EnrolToken {
  tokenHash: string;
  role: NodeRole;
  note: string;
  issuedAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export interface PendingNode {
  id: string;
  role: NodeRole;
  publicKey: string;
  hostname: string;
  addresses: string[];
  nodeTokenHash: string;
  enrolledAt: number;
}

export interface Registry {
  enrolTokens: EnrolToken[];
  pending: PendingNode[];
  /** siteId → node token hash of the approved node serving that site. */
  bindings: Record<string, { nodeTokenHash: string; role: NodeRole }>;
}

export const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;

export function emptyRegistry(): Registry {
  return { enrolTokens: [], pending: [], bindings: {} };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function issueEnrolToken(
  reg: Registry,
  role: NodeRole,
  note: string,
  now: number,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS,
): string {
  const token = randomBytes(32).toString("hex");
  reg.enrolTokens.push({
    tokenHash: hashToken(token),
    role,
    note,
    issuedAt: now,
    expiresAt: now + ttlMs,
    usedAt: null,
  });
  return token;
}

export interface EnrolRequest {
  token: string;
  publicKey: string;
  hostname: string;
  addresses: string[];
}

export type EnrolResult =
  | { ok: true; nodeToken: string; pendingId: string }
  | { ok: false; reason: "invalid-token" | "expired" | "already-used" | "bad-key" };

const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/** Consume an enrolment token and create a pending node. */
export function enrol(reg: Registry, req: EnrolRequest, now: number): EnrolResult {
  const hash = hashToken(req.token);
  const entry = reg.enrolTokens.find((t) => t.tokenHash === hash);
  if (!entry) return { ok: false, reason: "invalid-token" };
  if (entry.usedAt !== null) return { ok: false, reason: "already-used" };
  if (now > entry.expiresAt) return { ok: false, reason: "expired" };
  if (!WG_KEY_RE.test(req.publicKey)) return { ok: false, reason: "bad-key" };

  entry.usedAt = now;
  const nodeToken = randomBytes(32).toString("hex");
  const pendingId = "p-" + randomBytes(6).toString("hex");
  reg.pending.push({
    id: pendingId,
    role: entry.role,
    publicKey: req.publicKey,
    hostname: req.hostname,
    addresses: req.addresses,
    nodeTokenHash: hashToken(nodeToken),
    enrolledAt: now,
  });
  return { ok: true, nodeToken, pendingId };
}

export type AuthResult =
  | { status: "active"; siteId: string; role: NodeRole }
  | { status: "pending" }
  | { status: "unknown" };

/** Resolve a node bearer token to its binding. */
export function authenticate(reg: Registry, token: string): AuthResult {
  const hash = hashToken(token);
  for (const [siteId, b] of Object.entries(reg.bindings)) {
    if (b.nodeTokenHash === hash) return { status: "active", siteId, role: b.role };
  }
  if (reg.pending.some((p) => p.nodeTokenHash === hash)) return { status: "pending" };
  return { status: "unknown" };
}

/**
 * Approve a pending node, binding it to a site id. The caller is responsible
 * for adding the site (with the pending node's public key) to sites.yml in
 * the same operation — approval and topology entry go together.
 */
export function approve(reg: Registry, pendingId: string, siteId: string): PendingNode {
  const idx = reg.pending.findIndex((p) => p.id === pendingId);
  if (idx === -1) throw new Error(`no pending node ${pendingId}`);
  if (reg.bindings[siteId]) throw new Error(`site ${siteId} already has a bound node`);
  const node = reg.pending[idx]!;
  reg.pending.splice(idx, 1);
  reg.bindings[siteId] = { nodeTokenHash: node.nodeTokenHash, role: node.role };
  return node;
}

/** Reject (drop) a pending node. Its node token becomes worthless. */
export function reject(reg: Registry, pendingId: string): void {
  const idx = reg.pending.findIndex((p) => p.id === pendingId);
  if (idx === -1) throw new Error(`no pending node ${pendingId}`);
  reg.pending.splice(idx, 1);
}

/** Remove an approved node binding (decommission). */
export function removeBinding(reg: Registry, siteId: string): void {
  if (!reg.bindings[siteId]) throw new Error(`no binding for ${siteId}`);
  delete reg.bindings[siteId];
}

/** Housekeeping: drop expired, unused tokens. */
export function pruneTokens(reg: Registry, now: number): void {
  reg.enrolTokens = reg.enrolTokens.filter((t) => t.usedAt !== null || now <= t.expiresAt);
}

/** Key fingerprint shown to the admin for out-of-band verification. */
export function keyFingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey, "utf8").digest("hex").slice(0, 16);
}
