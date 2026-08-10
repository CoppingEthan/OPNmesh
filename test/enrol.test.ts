import { describe, expect, it } from "vitest";
import {
  approve,
  authenticate,
  emptyRegistry,
  enrol,
  hashToken,
  issueEnrolToken,
  keyFingerprint,
  pruneTokens,
  reject,
  removeBinding,
} from "../lib/enrol/registry.js";

const KEY = "a".repeat(43) + "=";
const NOW = 1_700_000_000_000;

function enrolReq(token: string) {
  return { token, publicKey: KEY, hostname: "gw-x", addresses: ["198.51.100.40"] };
}

describe("enrolment registry", () => {
  it("full happy path: issue → enrol → pending → approve → active", () => {
    const reg = emptyRegistry();
    const token = issueEnrolToken(reg, "gateway", "site-d", NOW);
    expect(reg.enrolTokens[0]!.tokenHash).toBe(hashToken(token));

    const res = enrol(reg, enrolReq(token), NOW + 1000);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    // Pending: authenticated but no access.
    expect(authenticate(reg, res.nodeToken)).toEqual({ status: "pending" });

    const node = approve(reg, res.pendingId, "site-d");
    expect(node.publicKey).toBe(KEY);
    expect(authenticate(reg, res.nodeToken)).toEqual({
      status: "active",
      siteId: "site-d",
      role: "gateway",
    });
  });

  it("tokens are single-use", () => {
    const reg = emptyRegistry();
    const token = issueEnrolToken(reg, "gateway", "x", NOW);
    expect(enrol(reg, enrolReq(token), NOW).ok).toBe(true);
    const second = enrol(reg, enrolReq(token), NOW + 1);
    expect(second).toEqual({ ok: false, reason: "already-used" });
  });

  it("tokens expire (15 min default)", () => {
    const reg = emptyRegistry();
    const token = issueEnrolToken(reg, "gateway", "x", NOW);
    const res = enrol(reg, enrolReq(token), NOW + 16 * 60 * 1000);
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects unknown tokens and malformed keys", () => {
    const reg = emptyRegistry();
    expect(enrol(reg, enrolReq("nope"), NOW)).toEqual({ ok: false, reason: "invalid-token" });
    const token = issueEnrolToken(reg, "gateway", "x", NOW);
    const bad = enrol(reg, { ...enrolReq(token), publicKey: "not-a-key" }, NOW);
    expect(bad).toEqual({ ok: false, reason: "bad-key" });
  });

  it("a rejected pending node's token becomes worthless", () => {
    const reg = emptyRegistry();
    const token = issueEnrolToken(reg, "gateway", "x", NOW);
    const res = enrol(reg, enrolReq(token), NOW);
    if (!res.ok) throw new Error("unreachable");
    reject(reg, res.pendingId);
    expect(authenticate(reg, res.nodeToken)).toEqual({ status: "unknown" });
  });

  it("a site can hold only one bound node; removal frees it", () => {
    const reg = emptyRegistry();
    const t1 = issueEnrolToken(reg, "gateway", "x", NOW);
    const r1 = enrol(reg, enrolReq(t1), NOW);
    if (!r1.ok) throw new Error("unreachable");
    approve(reg, r1.pendingId, "site-d");

    const t2 = issueEnrolToken(reg, "gateway", "y", NOW);
    const r2 = enrol(reg, { ...enrolReq(t2), publicKey: "b".repeat(43) + "=" }, NOW);
    if (!r2.ok) throw new Error("unreachable");
    expect(() => approve(reg, r2.pendingId, "site-d")).toThrow(/already has a bound node/);

    removeBinding(reg, "site-d");
    approve(reg, r2.pendingId, "site-d");
    expect(authenticate(reg, r2.nodeToken).status).toBe("active");
  });

  it("prunes expired unused tokens but keeps used ones for audit", () => {
    const reg = emptyRegistry();
    issueEnrolToken(reg, "gateway", "unused", NOW);
    const used = issueEnrolToken(reg, "gateway", "used", NOW);
    enrol(reg, enrolReq(used), NOW);
    pruneTokens(reg, NOW + 20 * 60 * 1000);
    expect(reg.enrolTokens).toHaveLength(1);
    expect(reg.enrolTokens[0]!.note).toBe("used");
  });

  it("fingerprints are stable and short enough to read out", () => {
    expect(keyFingerprint(KEY)).toBe(keyFingerprint(KEY));
    expect(keyFingerprint(KEY)).toHaveLength(16);
  });
});
