import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./helpers";
import { isNotNull } from "drizzle-orm";
import Database from "better-sqlite3";
import { getDb } from "@/db";
import { enrolTokens } from "@/db/schema";
import { setEnvForTests } from "@/server/env";
import { getSettings, publicUrl, updateSettings, SettingsError } from "@/server/settings";
import { addLan, createEnrolToken, createSite, deleteSite, enrolGateway, getSite, listSites, pruneEnrolTokens, removeLan, updateGateway, updateLan, updateSite, SiteError, gatewayByToken } from "@/server/sites";
import { liveState, telemetrySchema } from "@/server/live";
import { ingestTelemetry } from "@/server/telemetry";
import { clientPrivateKey, consumeInvite, createClient, createInvite, deleteClient, expireClients, getClient, peekInvite, rotateClientKeys, updateClient, ClientError } from "@/server/clients";
import { getGenerated, renderClientConf } from "@/server/snapshot";
import { listEvents } from "@/server/events";
import { publicKeyFromPrivate, generateKeyPair } from "@/core/crypto";

beforeEach(() => {
  freshDb();
});

const KEY = () => generateKeyPair().publicKey;

function enrolAt(siteId: string, addresses = ["10.0.250.2"], autoApprove = true) {
  const { token } = createEnrolToken(siteId, { autoApprove });
  const r = enrolGateway({ token, publicKey: KEY(), hostname: "gw-1", os: "ubuntu 24.04", arch: "amd64", addresses, agentVersion: "2.0.0" });
  if (!r.ok) throw new Error(r.reason);
  return r;
}

describe("settings", () => {
  it("starts with defaults and validates changes", () => {
    const s = getSettings();
    expect(s.gatewayCidr).toBe("10.99.0.0/24");
    expect(s.configVersion).toBe(1);
    expect(() => updateSettings({ gatewayCidr: "10.99.1.0/24" })).toThrow(SettingsError);
    expect(() => updateSettings({ mtu: 9000 })).toThrow(SettingsError);
    updateSettings({ listenPort: 443, networkName: "Acme" });
    expect(getSettings().listenPort).toBe(443);
    expect(getSettings().configVersion).toBe(2);
    updateSettings({ networkName: "Acme Ltd" });
    expect(getSettings().configVersion).toBe(2); // cosmetic changes do not bump
  });
});

describe("sites and gateways", () => {
  it("creates sites with unique slugs and LANs", () => {
    const a = createSite({ name: "Head Office" });
    const b = createSite({ name: "Head Office" });
    expect(a.slug).toBe("head-office");
    expect(b.slug).toBe("head-office-2");
    addLan(a.id, { cidr: "192.168.20.0/24", name: "Staff", vlan: 20 });
    expect(() => addLan(a.id, { cidr: "192.168.20.5/24", name: "Bad" })).toThrow(SiteError);
    expect(() => addLan(a.id, { cidr: "nonsense", name: "Bad" })).toThrow(SiteError);
    expect(getSite(a.id)!.lans).toHaveLength(1);
    const v = getSettings().configVersion;
    updateLan(a.id, getSite(a.id)!.lans[0]!.id, { shared: false });
    expect(getSettings().configVersion).toBe(v + 1);
    removeLan(a.id, getSite(a.id)!.lans[0]!.id);
    expect(getSite(a.id)!.lans).toHaveLength(0);
    deleteSite(b.id);
    expect(listSites()).toHaveLength(1);
  });

  it("enrols a gateway with a one-time token and assigns a tunnel address", () => {
    const site = createSite({ name: "DC" });
    const { token } = createEnrolToken(site.id);
    const bad = enrolGateway({ token: "nope", publicKey: KEY(), hostname: "x", os: "", arch: "", addresses: ["10.0.0.2"], agentVersion: "" });
    expect(bad).toEqual({ ok: false, reason: "invalid-token" });
    const r = enrolGateway({ token, publicKey: KEY(), hostname: "gw-dc", os: "ubuntu", arch: "amd64", addresses: ["10.0.250.2", "203.0.113.5"], agentVersion: "2.0.0" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("active");
    const g = getSite(site.id)!.gateway!;
    expect(g.tunnelIp).toBe("10.99.0.1");
    expect(g.lanIp).toBe("10.0.250.2");
    expect(g.status).toBe("active");
    expect(gatewayByToken(r.gatewayToken)?.id).toBe(r.gatewayId);
    expect(gatewayByToken("wrong")).toBeNull();
    // Token is single use.
    const again = enrolGateway({ token, publicKey: KEY(), hostname: "gw-dc", os: "", arch: "", addresses: ["10.0.250.3"], agentVersion: "" });
    expect(again).toEqual({ ok: false, reason: "used" });
  });

  it("supports manual approval and rejects bad keys", () => {
    const site = createSite({ name: "Branch" });
    const { token } = createEnrolToken(site.id, { autoApprove: false });
    const r = enrolGateway({ token, publicKey: "not-a-key", hostname: "x", os: "", arch: "", addresses: ["10.1.0.2"], agentVersion: "" });
    expect(r).toEqual({ ok: false, reason: "bad-key" });
    const r2 = enrolAt(site.id, ["10.1.0.2"], false);
    expect(r2.status).toBe("pending");
    expect(getGenerated().bundle.gateways[r2.gatewayId]).toBeUndefined(); // pending gateways generate nothing
    updateGateway(site.id, { status: "active", endpointHost: "branch.example.com" });
    expect(getGenerated().bundle.gateways[r2.gatewayId]).toBeDefined();
  });

  it("replacing a gateway keeps the site's addressing", () => {
    const site = createSite({ name: "DC" });
    const first = enrolAt(site.id);
    updateGateway(site.id, { endpointHost: "dc.example.com", listenPort: 51821 });
    const second = enrolAt(site.id, ["10.0.250.9"]);
    const g = getSite(site.id)!.gateway!;
    expect(g.id).toBe(second.gatewayId);
    expect(g.id).not.toBe(first.gatewayId);
    expect(g.tunnelIp).toBe("10.99.0.1");
    expect(g.lanIp).toBe("10.0.250.2");
    expect(g.endpointHost).toBe("dc.example.com");
    expect(g.listenPort).toBe(51821);
    expect(gatewayByToken(first.gatewayToken)).toBeNull();
  });

  it("validates gateway edits", () => {
    const site = createSite({ name: "DC" });
    enrolAt(site.id);
    expect(() => updateGateway(site.id, { endpointHost: "dc.example.com:51820" })).toThrow(SiteError);
    expect(() => updateGateway(site.id, { lanIp: "300.1.1.1" })).toThrow(SiteError);
    expect(() => updateGateway(site.id, { listenPort: 70000 })).toThrow(SiteError);
    expect(() => updateSite(site.id, { routerLayout: "weird" as never })).toThrow(SiteError);
  });
});

describe("clients", () => {
  it("creates clients with generated keys, sealed private keys and sequential addresses", () => {
    const a = createClient({ name: "Alice's laptop", owner: "alice@example.com" });
    const b = createClient({ name: "Bob phone" });
    expect(a.tunnelIp).toBe("10.99.1.1");
    expect(b.tunnelIp).toBe("10.99.1.2");
    expect(a.slug).toBe("alice-s-laptop");
    expect(a.privateKeyEnc.startsWith("v1.")).toBe(true);
    expect(publicKeyFromPrivate(clientPrivateKey(a))).toBe(a.publicKey);
    expect(() => createClient({ name: "" })).toThrow(ClientError);
    expect(() => createClient({ name: "x", allowedSiteIds: [] })).toThrow(ClientError);
    expect(() => createClient({ name: "x", allowedSiteIds: ["nope"] })).toThrow(ClientError);
  });

  it("rotates keys, disables, expires and deletes", () => {
    const c = createClient({ name: "Laptop" });
    const before = c.publicKey;
    const rotated = rotateClientKeys(c.id);
    expect(rotated.publicKey).not.toBe(before);
    expect(publicKeyFromPrivate(clientPrivateKey(rotated))).toBe(rotated.publicKey);
    updateClient(c.id, { expiresAt: Date.now() - 1000 });
    expect(expireClients()).toBe(1);
    expect(getClient(c.id)!.enabled).toBe(false);
    expect(expireClients()).toBe(0);
    deleteClient(c.id);
    expect(getClient(c.id)).toBeNull();
  });

  it("renders a complete config once there is a reachable site", () => {
    const site = createSite({ name: "DC" });
    addLan(site.id, { cidr: "10.0.1.0/24", name: "Servers" });
    enrolAt(site.id);
    updateGateway(site.id, { endpointHost: "dc.example.com" });
    const c = createClient({ name: "Laptop" });
    const conf = renderClientConf(c.id)!;
    expect(conf).toContain(`PrivateKey = ${clientPrivateKey(getClient(c.id)!)}`);
    expect(conf).toContain("Endpoint = dc.example.com:51820");
    expect(conf).toContain("AllowedIPs = 10.99.0.1/32, 10.0.1.0/24");
    expect(conf).not.toContain("{{");
  });

  it("invites are single use and expire", () => {
    const c = createClient({ name: "Laptop" });
    const { token } = createInvite(c.id, 1000);
    expect(peekInvite("bad")).toEqual({ error: "invalid" });
    const r = consumeInvite(token);
    expect("client" in r && r.client.id).toBe(c.id);
    expect(consumeInvite(token)).toEqual({ error: "used" });
    const { token: t2 } = createInvite(c.id, -1);
    expect(peekInvite(t2)).toEqual({ error: "expired" });
  });
});

describe("audit log", () => {
  it("records every change", () => {
    const site = createSite({ name: "DC" });
    addLan(site.id, { cidr: "10.0.1.0/24", name: "Servers" });
    createClient({ name: "Laptop" });
    const kinds = listEvents().map((e) => e.kind);
    expect(kinds).toEqual(["client", "lan", "site"]);
  });
});

describe("housekeeping", () => {
  it("prunes expired unused enrolment tokens at once and used ones after a week", () => {
    const site = createSite({ name: "DC" });
    createEnrolToken(site.id, { ttlMs: -1 }); // already expired, never used
    createEnrolToken(site.id); // live
    const used = createEnrolToken(site.id);
    const r = enrolGateway({ token: used.token, publicKey: KEY(), hostname: "gw", os: "", arch: "", addresses: ["10.0.250.2"], agentVersion: "" });
    expect(r.ok).toBe(true);
    expect(pruneEnrolTokens()).toBe(1);
    expect(getDb().select().from(enrolTokens).all()).toHaveLength(2);
    getDb().update(enrolTokens).set({ usedAt: Date.now() - 8 * 24 * 3600 * 1000 }).where(isNotNull(enrolTokens.usedAt)).run();
    expect(pruneEnrolTokens()).toBe(1);
    expect(getDb().select().from(enrolTokens).all()).toHaveLength(1);
  });

  it("forgets a removed gateway's live state", () => {
    const site = createSite({ name: "DC" });
    const r = enrolAt(site.id);
    const gw = getSite(site.id)!.gateway!;
    ingestTelemetry(gw, telemetrySchema.parse({ peers: [] }));
    expect(liveState().get(r.gatewayId)).toBeDefined();
    deleteSite(site.id);
    expect(liveState().get(r.gatewayId)).toBeUndefined();
  });

  it("normalises and validates the public URL override", () => {
    expect(publicUrl()).toBe("http://controller.test"); // the environment; tests run in insecure (lab) mode
    expect(updateSettings({ publicUrl: " https://mesh.example.com/ " }).publicUrl).toBe("https://mesh.example.com");
    expect(publicUrl()).toBe("https://mesh.example.com");
    expect(updateSettings({ publicUrl: "https://mesh.example.com:8443" }).publicUrl).toBe("https://mesh.example.com:8443");
    expect(updateSettings({ publicUrl: "" }).publicUrl).toBeNull();
    expect(publicUrl()).toBe("http://controller.test");
    for (const bad of ["mesh.example.com", "https://mesh.example.com/admin", "https://mesh.example.com/?x=1", "ftp://mesh.example.com", "https://user:pw@mesh.example.com"]) {
      expect(() => updateSettings({ publicUrl: bad }), bad).toThrow(SettingsError);
    }
    setEnvForTests({ insecureHttp: false });
    expect(() => updateSettings({ publicUrl: "http://mesh.example.com" })).toThrow(SettingsError);
  });

  it("uses better-sqlite3 buffers the way the backup route expects", () => {
    const copy = new Database(getDb().$client.serialize());
    expect((copy.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number }).n).toBe(1);
    copy.close();
  });
});
