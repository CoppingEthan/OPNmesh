/**
 * Control-server authentication primitives.
 *
 * Two distinct credentials, never interchangeable:
 *  - the ADMIN token authorises the management API (`/api/v1/admin/*`,
 *    `/api/v1/state`). Only the OPNmesh UI holds it.
 *  - per-NODE tokens authorise the agent API. They are issued at approval and
 *    only their hashes are stored (see lib/enrol/registry).
 *
 * Every comparison is constant-time: a timing oracle on either credential
 * would let an attacker on the network recover it byte by byte.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Constant-time string comparison that does not leak length via early exit. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function generateAdminToken(): string {
  return randomBytes(32).toString("hex");
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Admin credential check.
 *
 * The token is resolved on each verification rather than captured at startup,
 * so rotating it (rewriting the token file) takes effect immediately instead
 * of requiring a restart — during an incident, restarting the control node to
 * rotate a credential is exactly the wrong thing to have to do.
 */
export class AdminAuth {
  constructor(private readonly resolve: () => string | undefined) {
    const initial = resolve();
    if (!initial || initial.length < 32) {
      throw new Error(
        "OPNMESH_ADMIN_TOKEN must be set to a value of at least 32 characters. " +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
  }

  verify(authorizationHeader: string | undefined): boolean {
    const presented = bearerToken(authorizationHeader);
    if (presented === null) return false;
    const current = this.resolve();
    if (!current || current.length < 32) return false;
    return safeEqual(presented, current);
  }
}

/**
 * Fixed-window rate limiter, keyed by caller identity (usually source IP).
 * Applied to unauthenticated and credential-checking endpoints so brute-force
 * and enrolment-token guessing are bounded.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true when the request is allowed. */
  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** Drop expired buckets so the map cannot grow without bound. */
  sweep(now = Date.now()): void {
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
