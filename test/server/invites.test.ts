/**
 * An unused invite link is a copy of the client's private key waiting to be
 * collected: retiring the key or the client cancels it, a new link replaces
 * it, the admin can cancel it, and collecting it is single use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { adminHeaders, meshSite, params, req } from "./route-helpers";
import { getDb } from "@/db";
import { invites } from "@/db/schema";
import { consumeInvite, createClient, createInvite, deleteClient, expireClients, getClient, peekInvite, pendingInvite, revokeInvites, updateClient, ClientError, clientPrivateKey } from "@/server/clients";
import { resetRateLimitsForTests } from "@/server/http";
import { setEnvForTests } from "@/server/env";
import { updateGateway } from "@/server/sites";
import { listEvents } from "@/server/events";
import { DELETE as inviteDelete, GET as inviteStatus, POST as invitePost } from "../../app/api/admin/clients/[id]/invite/route";
import { POST as rotatePost } from "../../app/api/admin/clients/[id]/rotate/route";
import { GET as invitePeek, POST as invitePickup } from "../../app/api/invite/[token]/route";

beforeEach(() => {
  freshDb();
  resetRateLimitsForTests();
});
afterEach(() => vi.restoreAllMocks());

/** A client that can be handed a working config. */
function readyClient(name = "Laptop") {
  meshSite("DC", "10.0.1.0/24", "10.0.250.2", "dc.example.com", 1);
  return createClient({ name });
}

const pickup = (token: string) => invitePickup(req("POST", `/api/invite/${token}`), params({ token }));
const peek = (token: string) => invitePeek(req("GET", `/api/invite/${token}`), params({ token }));
const unused = (clientId: string) => getDb().select().from(invites).all().filter((i) => i.clientId === clientId && i.usedAt === null);

describe("retiring a key or a client cancels its links", () => {
  it("rotation: a link made before cannot hand out the new key", async () => {
    const c = readyClient();
    const { token } = createInvite(c.id);
    const res = await rotatePost(req("POST", `/api/admin/clients/${c.id}/rotate`, undefined, adminHeaders()), params({ id: c.id }));
    expect(res.status).toBe(200);
    expect(unused(c.id)).toHaveLength(0);
    const r = await pickup(token);
    expect(r.status).toBe(404);
    const body = await r.text();
    expect(body).not.toContain(clientPrivateKey(getClient(c.id)!));
    expect(body).not.toContain("PrivateKey");
    expect(listEvents()[0]!.message).toContain("unused invite links no longer work");
  });

  it("disabling, expiry and deletion", () => {
    const a = readyClient("A");
    const b = createClient({ name: "B", expiresAt: Date.now() + 60_000 });
    const c = createClient({ name: "C" });
    const la = createInvite(a.id);
    const lb = createInvite(b.id);
    const lc = createInvite(c.id);

    updateClient(a.id, { enabled: false });
    expect(peekInvite(la.token)).toEqual({ error: "invalid" });

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    expect(expireClients()).toBe(1);
    expect(peekInvite(lb.token)).toEqual({ error: "invalid" });
    vi.restoreAllMocks();

    deleteClient(c.id);
    expect(peekInvite(lc.token)).toEqual({ error: "invalid" });
    expect(getDb().select().from(invites).all()).toHaveLength(0);
  });

  it("a disabled client cannot be sent a link, and an old one would not open", () => {
    const c = readyClient();
    const { token } = createInvite(c.id);
    // Disabled behind the invite's back (e.g. an older database): pickup still refuses.
    getDb().$client.prepare("UPDATE clients SET enabled = 0 WHERE id = ?").run(c.id);
    expect(peekInvite(token)).toEqual({ error: "invalid" });
    expect(consumeInvite(token)).toEqual({ error: "invalid" });
    expect(() => createInvite(c.id)).toThrow(ClientError);
  });
});

describe("one link per client", () => {
  it("a new link replaces the unused one; a collected one is kept for the record", async () => {
    const c = readyClient();
    const first = createInvite(c.id);
    expect((await pickup(first.token)).status).toBe(200);
    const second = createInvite(c.id);
    const third = createInvite(c.id);
    expect(peekInvite(second.token)).toEqual({ error: "invalid" });
    expect("client" in peekInvite(third.token)).toBe(true);
    expect(getDb().select().from(invites).all()).toHaveLength(2);
  });

  it("the admin can see and cancel a pending link", async () => {
    const c = readyClient();
    const admin = adminHeaders();
    const status = async () => (await (await inviteStatus(req("GET", `/api/admin/clients/${c.id}/invite`, undefined, admin), params({ id: c.id }))).json()).pending;
    expect(await status()).toBeNull();
    const made = await (await invitePost(req("POST", `/api/admin/clients/${c.id}/invite`, {}, admin), params({ id: c.id }))).json();
    const token = made.url.split("/").pop();
    expect(await status()).toEqual({ createdAt: expect.any(Number), expiresAt: made.expiresAt });
    expect(pendingInvite(c.id)?.expiresAt).toBe(made.expiresAt);

    // Cancelling needs a signed-in admin from the same origin.
    expect((await inviteDelete(req("DELETE", `/api/admin/clients/${c.id}/invite`), params({ id: c.id }))).status).toBe(401);
    expect((await inviteDelete(req("DELETE", `/api/admin/clients/${c.id}/invite`, undefined, { ...admin, origin: "https://evil.example" }), params({ id: c.id }))).status).toBe(403);
    const del = await inviteDelete(req("DELETE", `/api/admin/clients/${c.id}/invite`, undefined, admin), params({ id: c.id }));
    expect(await del.json()).toEqual({ ok: true, revoked: 1 });
    expect(await status()).toBeNull();
    expect((await peek(token)).status).toBe(404);
    expect((await pickup(token)).status).toBe(404);
    expect(listEvents()[0]!.message).toContain("cancelled");
    // Nothing to cancel is not an error; an unknown client is.
    expect(revokeInvites(c.id)).toBe(0);
    expect((await inviteDelete(req("DELETE", "/api/admin/clients/nope/invite", undefined, admin), params({ id: "nope" }))).status).toBe(404);
  });
});

describe("collecting a link", () => {
  it("builds the config first: a config that cannot be handed out leaves the link working", async () => {
    const c = createClient({ name: "Laptop" });
    const dc = meshSite("DC", "10.0.1.0/24", "10.0.250.2", null, 1); // nowhere to connect yet
    const { token } = createInvite(c.id);
    const early = await pickup(token);
    expect(early.status).toBe(409);
    expect((await early.json()).error).toContain("has not been used up");
    expect(unused(c.id)).toHaveLength(1);
    updateGateway(dc.site.id, { endpointHost: "dc.example.com" });
    const ok = await pickup(token);
    expect(ok.status).toBe(200);
    expect((await ok.json()).conf).toContain(`PrivateKey = ${clientPrivateKey(getClient(c.id)!)}`);
    expect((await pickup(token)).status).toBe(404);
  });

  it("is single use when two requests race", async () => {
    const c = readyClient();
    const { token } = createInvite(c.id);
    const results = await Promise.all([pickup(token), pickup(token), pickup(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404, 404]);
  });

  it("shows only the name before collection, and records who collected it", async () => {
    const c = readyClient();
    const { token } = createInvite(c.id);
    const look = await peek(token);
    expect(await look.json()).toEqual({ name: "Laptop" });
    setEnvForTests({ trustProxy: 1 });
    const ok = await invitePickup(req("POST", `/api/invite/${token}`, undefined, { "x-forwarded-for": "203.0.113.5, 198.51.100.44" }), params({ token }));
    expect(ok.status).toBe(200);
    const used = listEvents().find((e) => e.kind === "invite" && e.message.startsWith("Invite link used"));
    expect(used?.message).toBe('Invite link used for "Laptop" from 198.51.100.44');
  });

  it("does not open an expired link", async () => {
    const c = readyClient();
    const { token } = createInvite(c.id, -1);
    expect((await pickup(token)).status).toBe(404);
    expect(consumeInvite(token)).toEqual({ error: "expired" });
  });
});
