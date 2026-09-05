/**
 * Route handlers exercised directly with Request objects: the full lifecycle
 * an operator and a gateway go through, and the authentication boundaries.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./helpers";
import { setupCode } from "@/server/auth";
import { resetRateLimitsForTests } from "@/server/http";
import { generateKeyPair } from "@/core/crypto";
import { GET as setupGet, POST as setupPost } from "../../app/api/admin/setup/route";
import { POST as loginPost } from "../../app/api/admin/login/route";
import { POST as logoutPost } from "../../app/api/admin/logout/route";
import { GET as sitesGet, POST as sitesPost } from "../../app/api/admin/sites/route";
import { PATCH as sitePatch, DELETE as siteDelete } from "../../app/api/admin/sites/[id]/route";
import { POST as lanPost } from "../../app/api/admin/sites/[id]/lans/route";
import { POST as tokenPost } from "../../app/api/admin/sites/[id]/enrol-token/route";
import { PATCH as gatewayPatch } from "../../app/api/admin/sites/[id]/gateway/route";
import { GET as routerGet } from "../../app/api/admin/sites/[id]/router/route";
import { POST as clientsPost, GET as clientsGet } from "../../app/api/admin/clients/route";
import { GET as clientConfGet } from "../../app/api/admin/clients/[id]/config/route";
import { GET as clientQrGet } from "../../app/api/admin/clients/[id]/qr/route";
import { POST as invitePost } from "../../app/api/admin/clients/[id]/invite/route";
import { GET as inviteGet, POST as invitePickup } from "../../app/api/invite/[token]/route";
import { GET as stateGet } from "../../app/api/admin/state/route";
import { GET as settingsGet, PUT as settingsPut } from "../../app/api/admin/settings/route";
import { POST as enrolPost } from "../../app/api/agent/enrol/route";
import { GET as configGet } from "../../app/api/agent/config/route";
import { POST as telemetryPost } from "../../app/api/agent/telemetry/route";
import { GET as installGet } from "../../app/install.sh/route";

const BASE = "http://controller.test";

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(BASE + path, {
    method,
    headers: { "content-type": "application/json", host: "controller.test", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = <T>(p: T) => ({ params: Promise.resolve(p) });

let cookie = "";
const asAdmin = (h: Record<string, string> = {}) => ({ cookie, ...h });

async function setupAndLogin() {
  const r = await setupPost(req("POST", "/api/admin/setup", { code: setupCode(), email: "admin@example.com", password: "correct horse battery" }));
  expect(r.status).toBe(200);
  cookie = r.headers.get("set-cookie")!.split(";")[0]!;
}

beforeEach(async () => {
  freshDb();
  resetRateLimitsForTests();
  cookie = "";
});

describe("setup and auth boundaries", () => {
  it("reports setup state, refuses admin routes without a session, and signs in", async () => {
    expect(await (await setupGet(req("GET", "/api/admin/setup"))).json()).toEqual({ needsSetup: true });
    expect((await sitesGet(req("GET", "/api/admin/sites"))).status).toBe(401);
    await setupAndLogin();
    expect(await (await setupGet(req("GET", "/api/admin/setup"))).json()).toEqual({ needsSetup: false });
    expect((await sitesGet(req("GET", "/api/admin/sites", undefined, asAdmin()))).status).toBe(200);
    // Cross-origin mutation is refused; same-origin accepted.
    expect((await sitesPost(req("POST", "/api/admin/sites", { name: "X" }, asAdmin({ origin: "https://evil.example" })))).status).toBe(403);
    expect((await sitesPost(req("POST", "/api/admin/sites", { name: "X" }, asAdmin({ origin: "http://controller.test" })))).status).toBe(201);
    // Logout kills the session.
    await logoutPost(req("POST", "/api/admin/logout", undefined, asAdmin()));
    expect((await sitesGet(req("GET", "/api/admin/sites", undefined, asAdmin()))).status).toBe(401);
    const bad = await loginPost(req("POST", "/api/admin/login", { email: "admin@example.com", password: "nope nope nope" }));
    expect(bad.status).toBe(401);
    const good = await loginPost(req("POST", "/api/admin/login", { email: "admin@example.com", password: "correct horse battery" }));
    expect(good.status).toBe(200);
    expect(good.headers.get("set-cookie")).toContain("HttpOnly");
  }, 30_000);

  it("validates bodies", async () => {
    await setupAndLogin();
    const r = await sitesPost(req("POST", "/api/admin/sites", { name: "" }, asAdmin()));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("name");
    const r2 = await sitesPost(new Request(BASE + "/api/admin/sites", { method: "POST", headers: { cookie, host: "controller.test" }, body: "not json" }));
    expect(r2.status).toBe(400);
    const r3 = await settingsPut(req("PUT", "/api/admin/settings", { mtu: 9000 }, asAdmin()));
    expect(r3.status).toBe(400);
  }, 30_000);
});

describe("gateway lifecycle through the API", () => {
  it("site → token → enrol → config → telemetry → state", async () => {
    await setupAndLogin();
    const site = await (await sitesPost(req("POST", "/api/admin/sites", { name: "Datacentre", hubPriority: 1 }, asAdmin()))).json();
    expect(site.slug).toBe("datacentre");
    const lan = await lanPost(req("POST", `/api/admin/sites/${site.id}/lans`, { cidr: "10.0.1.0/24", name: "Servers", vlan: 10 }, asAdmin()), params({ id: site.id }));
    expect(lan.status).toBe(201);

    const tok = await (await tokenPost(req("POST", `/api/admin/sites/${site.id}/enrol-token`, {}, asAdmin()), params({ id: site.id }))).json();
    expect(tok.command).toContain("curl -fsSL http://controller.test/install.sh");
    expect(tok.command).toContain(`--token ${tok.token}`);
    expect(tok.command).toContain("--insecure-http");
    expect(tok.installScriptSha256).toMatch(/^[a-f0-9]{64}$/);

    // The installer is served with the URL baked in.
    const script = await (await installGet()).text();
    expect(script).toContain('CONTROLLER="http://controller.test"');
    expect(script).toContain("opnmesh-gw enrol --controller");
    expect(script).not.toContain("__OPNMESH_URL__");

    // Agent side: enrol with only the public key.
    const kp = generateKeyPair();
    const bad = await enrolPost(req("POST", "/api/agent/enrol", { token: "x".repeat(43), publicKey: kp.publicKey, addresses: ["10.0.250.2"] }));
    expect(bad.status).toBe(403);
    const enrol = await enrolPost(req("POST", "/api/agent/enrol", { token: tok.token, publicKey: kp.publicKey, hostname: "gw-dc", os: "Ubuntu 24.04", arch: "amd64", addresses: ["10.0.250.2"], agentVersion: "2.0.0" }));
    expect(enrol.status).toBe(201);
    const { gatewayToken, status } = await enrol.json();
    expect(status).toBe("active");
    const auth = { authorization: `Bearer ${gatewayToken}` };

    // Gateway tokens open nothing on the admin side.
    expect((await sitesGet(req("GET", "/api/admin/sites", undefined, auth))).status).toBe(401);
    expect((await configGet(req("GET", "/api/agent/config", undefined, { authorization: "Bearer wrong-token-wrong-token" }))).status).toBe(401);

    // Config: 200 then 304 on the ETag.
    const cfg = await configGet(req("GET", "/api/agent/config", undefined, auth));
    expect(cfg.status).toBe(200);
    const cfgBody = await cfg.json();
    expect(cfgBody.files["wireguard.conf"]).toContain("Address = 10.99.0.1/24");
    expect(cfgBody.files["wireguard.conf"]).not.toContain("PrivateKey");
    expect(cfgBody.meta.telemetryIntervalSeconds).toBe(5);
    const etag = cfg.headers.get("etag")!;
    expect((await configGet(req("GET", "/api/agent/config", undefined, { ...auth, "if-none-match": etag }))).status).toBe(304);

    // Telemetry returns the desired hash; a config change changes it.
    const t1 = await (await telemetryPost(req("POST", "/api/agent/telemetry", { version: "2.0.0", appliedHash: cfgBody.hash, diskHash: cfgBody.hash, peers: [] }, auth))).json();
    expect(t1.configHash).toBe(cfgBody.hash);
    // An endpoint change alters other peers' files, not this gateway's own; a port change alters its [Interface].
    await gatewayPatch(req("PATCH", `/api/admin/sites/${site.id}/gateway`, { endpointHost: "dc.example.com", listenPort: 51821 }, asAdmin()), params({ id: site.id }));
    const t2 = await (await telemetryPost(req("POST", "/api/agent/telemetry", { version: "2.0.0", appliedHash: cfgBody.hash, diskHash: cfgBody.hash, peers: [] }, auth))).json();
    expect(t2.configHash).not.toBe(cfgBody.hash);
    expect((await configGet(req("GET", "/api/agent/config", undefined, { ...auth, "if-none-match": etag }))).status).toBe(200);

    // Router plan and dashboard state.
    const router = await (await routerGet(req("GET", `/api/admin/sites/${site.id}/router`, undefined, asAdmin()), params({ id: site.id }))).json();
    expect(router.plan.nextHop).toBe("10.0.250.2");
    expect(router.plan.portForward).toEqual({ protocol: "udp", port: 51821, toIp: "10.0.250.2" });
    expect(router.text).toContain("10.99.1.0/24");
    const state = await (await stateGet(req("GET", "/api/admin/state", undefined, asAdmin()))).json();
    expect(state.sites[0].gateway.health).toBe("online");
    expect(state.sites[0].reachable).toBe(true);
    expect(state.headline.level).toBe("warn"); // reported hash is stale after the endpoint change
    expect(state.headline.detail).toContain("not yet applied");

    // Once the gateway applies the new hash the headline is clean.
    await telemetryPost(req("POST", "/api/agent/telemetry", { version: "2.0.0", appliedHash: t2.configHash, diskHash: t2.configHash, peers: [], interfaceUp: true }, auth));
    const state2 = await (await stateGet(req("GET", "/api/admin/state", undefined, asAdmin()))).json();
    expect(state2.headline.level).toBe("ok");
    expect(state2.headline.title).toContain("Datacentre is online");

    // Disabling the gateway stops config.
    await gatewayPatch(req("PATCH", `/api/admin/sites/${site.id}/gateway`, { status: "disabled" }, asAdmin()), params({ id: site.id }));
    expect((await configGet(req("GET", "/api/agent/config", undefined, auth))).status).toBe(403);
    await sitePatch(req("PATCH", `/api/admin/sites/${site.id}`, { name: "DC" }, asAdmin()), params({ id: site.id }));
    expect((await siteDelete(req("DELETE", `/api/admin/sites/${site.id}`, undefined, asAdmin()), params({ id: site.id }))).status).toBe(200);
    expect((await configGet(req("GET", "/api/agent/config", undefined, auth))).status).toBe(401);
  }, 60_000);

  it("pending gateways get 202 until approved", async () => {
    await setupAndLogin();
    const site = await (await sitesPost(req("POST", "/api/admin/sites", { name: "Branch" }, asAdmin()))).json();
    const tok = await (await tokenPost(req("POST", `/api/admin/sites/${site.id}/enrol-token`, { autoApprove: false }, asAdmin()), params({ id: site.id }))).json();
    const enrol = await (await enrolPost(req("POST", "/api/agent/enrol", { token: tok.token, publicKey: generateKeyPair().publicKey, addresses: ["10.1.0.2"] }))).json();
    expect(enrol.status).toBe("pending");
    const auth = { authorization: `Bearer ${enrol.gatewayToken}` };
    expect((await configGet(req("GET", "/api/agent/config", undefined, auth))).status).toBe(202);
    const t = await (await telemetryPost(req("POST", "/api/agent/telemetry", { peers: [] }, auth))).json();
    expect(t.status).toBe("pending");
    await gatewayPatch(req("PATCH", `/api/admin/sites/${site.id}/gateway`, { status: "active" }, asAdmin()), params({ id: site.id }));
    expect((await configGet(req("GET", "/api/agent/config", undefined, auth))).status).toBe(200);
  }, 30_000);
});

describe("clients through the API", () => {
  it("creates a client, serves config/QR, and hands it over once via an invite", async () => {
    await setupAndLogin();
    const site = await (await sitesPost(req("POST", "/api/admin/sites", { name: "DC" }, asAdmin()))).json();
    await lanPost(req("POST", `/api/admin/sites/${site.id}/lans`, { cidr: "10.0.1.0/24", name: "Servers" }, asAdmin()), params({ id: site.id }));
    const tok = await (await tokenPost(req("POST", `/api/admin/sites/${site.id}/enrol-token`, {}, asAdmin()), params({ id: site.id }))).json();
    await enrolPost(req("POST", "/api/agent/enrol", { token: tok.token, publicKey: generateKeyPair().publicKey, addresses: ["10.0.250.2"] }));

    const created = await clientsPost(req("POST", "/api/admin/clients", { name: "Alice laptop", owner: "alice@example.com" }, asAdmin()));
    expect(created.status).toBe(201);
    const client = await created.json();
    expect(client.privateKeyEnc).toBeUndefined();
    expect(client.tunnelIp).toBe("10.99.1.1");
    const list = await (await clientsGet(req("GET", "/api/admin/clients", undefined, asAdmin()))).json();
    expect(list).toHaveLength(1);

    // No reachable site yet → 409 with a helpful message.
    const noConf = await clientConfGet(req("GET", `/api/admin/clients/${client.id}/config`, undefined, asAdmin()), params({ id: client.id }));
    expect(noConf.status).toBe(409);
    await gatewayPatch(req("PATCH", `/api/admin/sites/${site.id}/gateway`, { endpointHost: "dc.example.com" }, asAdmin()), params({ id: site.id }));

    const conf = await clientConfGet(req("GET", `/api/admin/clients/${client.id}/config?download=1`, undefined, asAdmin()), params({ id: client.id }));
    expect(conf.status).toBe(200);
    expect(conf.headers.get("content-disposition")).toContain('filename="alice-laptop.conf"');
    const confText = await conf.text();
    expect(confText).toMatch(/PrivateKey = [A-Za-z0-9+/]{43}=/);
    expect(confText).toContain("Endpoint = dc.example.com:51820");
    const qr = await clientQrGet(req("GET", `/api/admin/clients/${client.id}/qr`, undefined, asAdmin()), params({ id: client.id }));
    expect(qr.headers.get("content-type")).toBe("image/svg+xml");
    expect((await qr.text()).startsWith("<svg")).toBe(true);
    const png = await clientQrGet(req("GET", `/api/admin/clients/${client.id}/qr?format=png`, undefined, asAdmin()), params({ id: client.id }));
    expect(png.headers.get("content-type")).toBe("image/png");

    // Invite: public, single use.
    const inv = await (await invitePost(req("POST", `/api/admin/clients/${client.id}/invite`, {}, asAdmin()), params({ id: client.id }))).json();
    expect(inv.url).toMatch(/^http:\/\/controller\.test\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = inv.url.split("/").pop()!;
    const peek = await (await inviteGet(req("GET", `/api/invite/${token}`), params({ token }))).json();
    expect(peek.name).toBe("Alice laptop");
    const pickup = await invitePickup(req("POST", `/api/invite/${token}`), params({ token }));
    expect(pickup.status).toBe(200);
    const body = await pickup.json();
    expect(body.conf).toBe(confText);
    expect(body.qrSvg.startsWith("<svg")).toBe(true);
    expect((await invitePickup(req("POST", `/api/invite/${token}`), params({ token }))).status).toBe(404);
    expect((await inviteGet(req("GET", `/api/invite/nonsense`), params({ token: "nonsense" }))).status).toBe(404);

    expect((await settingsGet(req("GET", "/api/admin/settings", undefined, asAdmin()))).status).toBe(200);
  }, 60_000);
});
