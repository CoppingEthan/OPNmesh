/**
 * Validation errors hold back the configs they reach: the gateway API answers
 * 409 and telemetry stops advertising the new hash, client configs, QR codes
 * and invite pickups are refused, and the admin can see why.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./helpers";
import { adminHeaders, bearer, gatewayOf, meshSite, params, req } from "./route-helpers";
import { getDb } from "@/db";
import { settings } from "@/db/schema";
import { createClient, createInvite, peekInvite } from "@/server/clients";
import { resetRateLimitsForTests } from "@/server/http";
import { bumpConfigVersion } from "@/server/settings";
import { addLan, createSite, deleteSite, getSite, removeLan } from "@/server/sites";
import { getGenerated } from "@/server/snapshot";
import { GET as configGet } from "../../app/api/agent/config/route";
import { POST as telemetryPost } from "../../app/api/agent/telemetry/route";
import { GET as clientConfGet } from "../../app/api/admin/clients/[id]/config/route";
import { GET as clientQrGet } from "../../app/api/admin/clients/[id]/qr/route";
import { POST as invitePickup } from "../../app/api/invite/[token]/route";
import { GET as stateGet } from "../../app/api/admin/state/route";

beforeEach(() => {
  freshDb();
  resetRateLimitsForTests();
});

function mesh() {
  const dc = meshSite("DC", "10.0.1.0/24", "10.0.250.2", "dc.example.com", 1);
  const office = meshSite("Office", "192.168.20.0/24", "192.168.20.2", "203.0.113.20", 2);
  const temp = createSite({ name: "Temp" });
  const open = createClient({ name: "Open laptop" });
  const restricted = createClient({ name: "Restricted laptop", allowedSiteIds: [office.site.id, temp.id] });
  return { dc, office, temp, open, restricted };
}

const admin = () => adminHeaders();
const agentConfig = (token: string) => configGet(req("GET", "/api/agent/config", undefined, bearer(token)));
const report = async (token: string) => (await telemetryPost(req("POST", "/api/agent/telemetry", { peers: [] }, bearer(token)))).json();
const clientConf = (id: string) => clientConfGet(req("GET", `/api/admin/clients/${id}/config`, undefined, admin()), params({ id }));
const clientQr = (id: string) => clientQrGet(req("GET", `/api/admin/clients/${id}/qr`, undefined, admin()), params({ id }));
const pickup = (token: string) => invitePickup(req("POST", `/api/invite/${token}`), params({ token }));
const state = async () => (await stateGet(req("GET", "/api/admin/state", undefined, admin()))).json();

describe("held configurations", () => {
  it("serve everything while there is no error", async () => {
    const { dc, open } = mesh();
    expect((await agentConfig(dc.token)).status).toBe(200);
    expect((await report(dc.token)).configHash).toBe(getGenerated().bundle.gateways[gatewayOf(dc).id]!.hash);
    expect((await clientConf(open.id)).status).toBe(200);
    expect(getGenerated().held).toEqual({ gateways: {}, clients: {} });
  });

  it("hold only the client a client-level error is about", async () => {
    const { dc, office, temp, open, restricted } = mesh();
    const link = createInvite(restricted.id);
    deleteSite(temp.id); // leaves a reference to a site that no longer exists
    const conf = await clientConf(restricted.id);
    expect(conf.status).toBe(409);
    expect((await conf.json()).error).toContain("does not exist");
    expect((await clientQr(restricted.id)).status).toBe(409);
    const picked = await pickup(link.token);
    expect(picked.status).toBe(409);
    expect("client" in peekInvite(link.token)).toBe(true); // the link was not used up
    // Nothing else is held.
    expect((await clientConf(open.id)).status).toBe(200);
    expect((await agentConfig(dc.token)).status).toBe(200);
    expect((await agentConfig(office.token)).status).toBe(200);
    const s = await state();
    expect(s.clients.find((c: { id: string }) => c.id === restricted.id).held).toContain("does not exist");
    expect(s.clients.find((c: { id: string }) => c.id === open.id).held).toBeNull();
  });

  it("hold every gateway and client a site's error reaches, and release them once it is fixed", async () => {
    const { dc, office, open, restricted } = mesh();
    const goodHash = (await report(dc.token)).configHash;
    const link = createInvite(open.id);
    // A network inside the client range: written into every config that reaches the office.
    const bad = addLan(office.site.id, { cidr: "10.99.1.0/24", name: "Clash" });
    expect(getGenerated().findings.some((f) => f.level === "error")).toBe(true);

    for (const t of [dc, office]) {
      const r = await agentConfig(t.token);
      expect(r.status).toBe(409);
      const body = await r.json();
      expect(body.status).toBe("held");
      expect(body.error).toContain("overlaps the client range");
      // No new hash is advertised, so the agent keeps what it runs and does not ask.
      expect((await report(t.token)).configHash).toBe("");
    }
    for (const c of [open, restricted]) {
      expect((await clientConf(c.id)).status).toBe(409);
      expect((await clientQr(c.id)).status).toBe(409);
    }
    expect((await pickup(link.token)).status).toBe(409);

    // The admin sees what is held and why.
    const s = await state();
    const gw = s.sites.find((x: { id: string }) => x.id === dc.site.id).gateway;
    expect(gw.held).toContain("overlaps the client range");
    expect(gw.attention).toContain("on hold");
    expect(s.headline.level).toBe("bad");
    expect(s.headline.detail).toContain("4 affected configurations are on hold");
    expect(s.clients.every((c: { held: string | null }) => c.held !== null)).toBe(true);

    removeLan(office.site.id, bad.id);
    const next = await report(dc.token);
    expect(next.configHash).toBe(goodHash);
    expect((await agentConfig(dc.token)).status).toBe(200);
    const picked = await pickup(link.token);
    expect(picked.status).toBe(200);
    expect((await picked.json()).conf).toContain("[Peer]");
  });

  it("hold everything for an error in the shared settings", async () => {
    const { dc, office, open, restricted } = mesh();
    getDb().update(settings).set({ mtu: 9000 }).run();
    bumpConfigVersion();
    for (const t of [dc, office]) expect((await agentConfig(t.token)).status).toBe(409);
    for (const c of [open, restricted]) expect((await clientConf(c.id)).status).toBe(409);
    expect(Object.keys(getGenerated().held.gateways)).toHaveLength(2);
    expect(getSite(dc.site.id)!.gateway!.status).toBe("active");
  });

  it("hold nothing for an error about a site that is not in the mesh yet", async () => {
    const { dc, open } = mesh();
    const pending = createSite({ name: "Pending" });
    addLan(pending.id, { cidr: "10.0.1.0/24", name: "Same as DC" });
    expect(getGenerated().findings.some((f) => f.level === "error" && f.code === "overlap")).toBe(true);
    expect((await agentConfig(dc.token)).status).toBe(200);
    expect((await clientConf(open.id)).status).toBe(200);
    const s = await state();
    expect(s.headline.detail).not.toContain("on hold");
  });
});
