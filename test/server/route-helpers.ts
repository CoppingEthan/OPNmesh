/**
 * Route handlers called directly: requests, params, an admin session made
 * without the (slow) password hashing, and a small mesh with gateway tokens.
 */
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { generateKeyPair, randomId, randomToken, sha256Hex } from "@/core/crypto";
import { sessionCookieName } from "@/server/auth";
import { now } from "@/server/env";
import { addLan, createEnrolToken, createSite, enrolGateway, getSite, updateGateway, type SiteWithRelations } from "@/server/sites";

export const BASE = "http://controller.test";

export function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(BASE + path, {
    method,
    headers: { "content-type": "application/json", host: "controller.test", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const params = <T>(p: T) => ({ params: Promise.resolve(p) });

export function adminHeaders(): Record<string, string> {
  const userId = randomId();
  const token = randomToken();
  const t = now();
  getDb().insert(users).values({ id: userId, email: `admin-${userId}@example.com`, passwordHash: "unused", createdAt: t }).run();
  getDb()
    .insert(sessions)
    .values({ id: sha256Hex(token), userId, createdAt: t, lastSeenAt: t, expiresAt: t + 3_600_000 })
    .run();
  return { cookie: `${sessionCookieName()}=${token}` };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface TestSite {
  site: SiteWithRelations;
  token: string;
  publicKey: string;
}

/** A site with one shared LAN and an enrolled, active gateway; `endpoint` makes it reachable. */
export function meshSite(name: string, cidr: string, lanIp: string, endpoint: string | null, hubPriority?: number): TestSite {
  const s = createSite({ name, hubPriority });
  addLan(s.id, { cidr, name: "LAN" });
  const { token } = createEnrolToken(s.id);
  const publicKey = generateKeyPair().publicKey;
  const r = enrolGateway({ token, publicKey, hostname: s.slug, os: "", arch: "", addresses: [lanIp], agentVersion: "2.1.0" });
  if (!r.ok) throw new Error(r.reason);
  if (endpoint) updateGateway(s.id, { endpointHost: endpoint });
  return { site: getSite(s.id)!, token: r.gatewayToken, publicKey };
}

/** The site's current gateway row (rows change as the mesh is edited). */
export const gatewayOf = (t: TestSite) => getSite(t.site.id)!.gateway!;
