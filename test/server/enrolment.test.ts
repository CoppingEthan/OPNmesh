/**
 * Enrolment: keys are unique across gateways and clients, the reported LAN
 * address must be one a host can hold, a site has one live token at a time,
 * and a token is spent exactly once even when two enrolments race.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { adminHeaders, params, req } from "./route-helpers";
import { getDb } from "@/db";
import { enrolTokens, gateways } from "@/db/schema";
import { generateKeyPair, sha256Hex } from "@/core/crypto";
import { createClient } from "@/server/clients";
import { resetRateLimitsForTests } from "@/server/http";
import { addLan, createEnrolToken, createSite, enrolGateway, getSite, updateGateway, SiteError, type EnrolRequest } from "@/server/sites";
import { POST as enrolPost } from "../../app/api/agent/enrol/route";
import { POST as tokenPost } from "../../app/api/admin/sites/[id]/enrol-token/route";

// getSettings runs between enrolment's checks and its transaction: the place
// another request could slip in. Tests use the hook to be that request.
const race = vi.hoisted(() => ({ hook: null as null | (() => void) }));
vi.mock("@/server/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/settings")>();
  return {
    ...real,
    getSettings: () => {
      const h = race.hook;
      race.hook = null;
      h?.();
      return real.getSettings();
    },
  };
});

beforeEach(() => {
  freshDb();
  resetRateLimitsForTests();
  race.hook = null;
});

const request = (token: string, over: Partial<EnrolRequest> = {}): EnrolRequest => ({ token, publicKey: generateKeyPair().publicKey, hostname: "gw", os: "", arch: "", addresses: ["10.0.250.2"], agentVersion: "2.1.0", ...over });
const unusedTokens = (siteId: string) => getDb().select().from(enrolTokens).all().filter((t) => t.siteId === siteId && t.usedAt === null);

function site(name = "DC") {
  const s = createSite({ name });
  addLan(s.id, { cidr: "10.0.1.0/24", name: "LAN" });
  return s;
}

describe("public keys", () => {
  it("refuses a roaming client's key as a gateway key", async () => {
    const s = site();
    const c = createClient({ name: "Laptop" });
    const { token } = createEnrolToken(s.id);
    expect(enrolGateway(request(token, { publicKey: c.publicKey }))).toEqual({ ok: false, reason: "duplicate-key" });
    // The token is not spent by the refusal.
    expect(unusedTokens(s.id)).toHaveLength(1);
  });

  it("answers 409 for another gateway's key, but lets a rebuilt VM keep its own", async () => {
    const a = site("A");
    const b = site("B");
    const key = generateKeyPair().publicKey;
    expect(enrolGateway(request(createEnrolToken(a.id).token, { publicKey: key })).ok).toBe(true);

    const { token } = createEnrolToken(b.id);
    const res = await enrolPost(req("POST", "/api/agent/enrol", request(token, { publicKey: key })));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "duplicate-key", error: expect.stringContaining("already belongs") });
    expect(getSite(b.id)!.gateway).toBeNull();

    const again = enrolGateway(request(createEnrolToken(a.id).token, { publicKey: key, hostname: "rebuilt" }));
    expect(again.ok).toBe(true);
    expect(getSite(a.id)!.gateway!.hostname).toBe("rebuilt");
  });

  it("answers 409, not 500, when another enrolment takes the key first", async () => {
    const a = site("A");
    const b = site("B");
    const key = generateKeyPair().publicKey;
    const { token } = createEnrolToken(b.id);
    race.hook = () => {
      expect(enrolGateway(request(createEnrolToken(a.id).token, { publicKey: key, addresses: ["10.0.250.3"] })).ok).toBe(true);
    };
    const res = await enrolPost(req("POST", "/api/agent/enrol", request(token, { publicKey: key })));
    expect(res.status).toBe(409);
    expect(getSite(b.id)!.gateway).toBeNull();
    // The failed attempt rolled back: its token can still be used with a fresh key.
    expect(unusedTokens(b.id)).toHaveLength(1);
    expect(enrolGateway(request(token)).ok).toBe(true);
  });
});

describe("the reported LAN address", () => {
  it("must be one a host can hold", async () => {
    for (const bad of ["0.0.0.0", "127.0.0.1", "169.254.1.1", "224.0.0.5", "255.255.255.255", "240.1.2.3"]) {
      const s = site(`S ${bad}`);
      const res = await enrolPost(req("POST", "/api/agent/enrol", request(createEnrolToken(s.id).token, { addresses: [bad] })));
      expect(res.status, bad).toBe(400);
      expect((await res.json()).reason).toBe("no-address");
    }
    // Unusable ones are skipped, not chosen.
    const s = site("Mixed");
    const r = enrolGateway(request(createEnrolToken(s.id).token, { addresses: ["127.0.0.1", "169.254.0.9", "192.168.5.2"] }));
    expect(r.ok).toBe(true);
    expect(getSite(s.id)!.gateway!.lanIp).toBe("192.168.5.2");
    expect(getSite(s.id)!.gateway!.addresses).toEqual(["192.168.5.2"]);
    // The same rule applies when the admin edits it.
    expect(() => updateGateway(s.id, { lanIp: "127.0.0.1" })).toThrow(SiteError);
    expect(updateGateway(s.id, { lanIp: "192.168.5.3" }).lanIp).toBe("192.168.5.3");
  });

  it("leaves out the tunnel address a re-enrolled VM's WireGuard interface still holds", () => {
    const s = site("Rebuilt");
    expect(enrolGateway(request(createEnrolToken(s.id).token, { addresses: ["10.0.1.2"] })).ok).toBe(true);
    const { tunnelIp } = getSite(s.id)!.gateway!;
    expect(enrolGateway(request(createEnrolToken(s.id).token, { addresses: ["10.0.1.2", tunnelIp] })).ok).toBe(true);
    expect(getSite(s.id)!.gateway!.tunnelIp).toBe(tunnelIp);
    expect(getSite(s.id)!.gateway!.addresses).toEqual(["10.0.1.2"]);
  });
});

describe("enrolment tokens", () => {
  it("a new token revokes the site's unused ones; other sites keep theirs", async () => {
    const s = site("A");
    const other = site("B");
    const otherTok = createEnrolToken(other.id);
    const admin = adminHeaders();
    const first = await (await tokenPost(req("POST", `/api/admin/sites/${s.id}/enrol-token`, {}, admin), params({ id: s.id }))).json();
    const second = await (await tokenPost(req("POST", `/api/admin/sites/${s.id}/enrol-token`, {}, admin), params({ id: s.id }))).json();
    expect(enrolGateway(request(first.token))).toEqual({ ok: false, reason: "invalid-token" });
    expect(unusedTokens(s.id).map((t) => t.tokenHash)).toEqual([sha256Hex(second.token)]);
    expect(enrolGateway(request(otherTok.token, { addresses: ["10.0.250.9"] })).ok).toBe(true);
  });

  it("a successful enrolment revokes the rest, and a token is spent once", () => {
    const s = site();
    const a = createEnrolToken(s.id);
    // A stray unused token (from before revocation existed).
    getDb()
      .insert(enrolTokens)
      .values({ id: "stray", siteId: s.id, tokenHash: sha256Hex("stray-token-stray-token"), autoApprove: true, expiresAt: Date.now() + 60_000, usedAt: null, createdBy: "t", createdAt: Date.now() })
      .run();
    expect(enrolGateway(request(a.token)).ok).toBe(true);
    expect(unusedTokens(s.id)).toHaveLength(0);
    expect(enrolGateway(request("stray-token-stray-token", { addresses: ["10.0.250.5"] }))).toEqual({ ok: false, reason: "invalid-token" });
    expect(enrolGateway(request(a.token, { addresses: ["10.0.250.5"] }))).toEqual({ ok: false, reason: "used" });
  });

  it("is spent once when two enrolments race with it", () => {
    const s = site();
    const { token } = createEnrolToken(s.id);
    let winner = "";
    race.hook = () => {
      const r = enrolGateway(request(token, { hostname: "first" }));
      if (r.ok) winner = r.gatewayId;
    };
    expect(enrolGateway(request(token, { hostname: "second" }))).toEqual({ ok: false, reason: "used" });
    expect(winner).not.toBe("");
    const rows = getDb().select().from(gateways).all();
    expect(rows.map((g) => g.hostname)).toEqual(["first"]);
    expect(getSite(s.id)!.gateway!.id).toBe(winner);
  });
});
