/**
 * Admin and agent API edges: no secret hashes in admin payloads, bounded
 * event pages, and health-check answers only from active gateways to
 * requests that were made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { adminHeaders, bearer, meshSite, params, req } from "./route-helpers";
import { logEvent } from "@/server/events";
import { requestDiagnostics } from "@/server/diagnostics";
import { createEnrolToken, getSite } from "@/server/sites";
import { createInvite, createClient } from "@/server/clients";
import { GET as sitesGet, POST as sitesPost } from "../../app/api/admin/sites/route";
import { GET as siteGet, PATCH as sitePatch } from "../../app/api/admin/sites/[id]/route";
import { PATCH as gatewayPatch } from "../../app/api/admin/sites/[id]/gateway/route";
import { GET as stateGet } from "../../app/api/admin/state/route";
import { GET as clientsGet } from "../../app/api/admin/clients/route";
import { GET as eventsGet } from "../../app/api/admin/events/route";
import { POST as diagPost } from "../../app/api/agent/diagnostics/route";

beforeEach(() => {
  freshDb();
});

/** Every key anywhere in a JSON value. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  }
  return out;
}
const SECRET_KEYS = ["tokenHash", "token_hash", "privateKeyEnc", "pskEnc", "passwordHash", "secretEnc", "smtpPassEnc"];

describe("admin payloads", () => {
  it("never carry token hashes or sealed secrets", async () => {
    const admin = adminHeaders();
    const dc = meshSite("DC", "10.0.1.0/24", "10.0.250.2", "dc.example.com", 1);
    const c = createClient({ name: "Laptop" });
    createInvite(c.id);
    createEnrolToken(dc.site.id);
    const id = dc.site.id;
    const bodies = [
      await (await sitesGet(req("GET", "/api/admin/sites", undefined, admin))).json(),
      await (await sitesPost(req("POST", "/api/admin/sites", { name: "Branch" }, admin))).json(),
      await (await siteGet(req("GET", `/api/admin/sites/${id}`, undefined, admin), params({ id }))).json(),
      await (await sitePatch(req("PATCH", `/api/admin/sites/${id}`, { notes: "x" }, admin), params({ id }))).json(),
      await (await gatewayPatch(req("PATCH", `/api/admin/sites/${id}/gateway`, { name: "Edge" }, admin), params({ id }))).json(),
      await (await stateGet(req("GET", "/api/admin/state", undefined, admin))).json(),
      await (await clientsGet(req("GET", "/api/admin/clients", undefined, admin))).json(),
      await (await eventsGet(req("GET", "/api/admin/events", undefined, admin))).json(),
    ];
    // The site responses still describe the gateway.
    expect(bodies[0][0].gateway.publicKey).toBe(dc.publicKey);
    expect(bodies[4].name).toBe("Edge");
    for (const [i, b] of bodies.entries()) {
      const keys = keysOf(b);
      for (const k of SECRET_KEYS) expect(keys.has(k), `${k} in response ${i}`).toBe(false);
    }
    expect(JSON.stringify(bodies)).not.toContain(getSite(id)!.gateway!.tokenHash);
  });
});

describe("event pages", () => {
  it("are clamped to 1–1000 and refuse malformed cursors", async () => {
    const admin = adminHeaders();
    for (let i = 0; i < 1005; i++) logEvent("system", `event ${i}`);
    const get = (q: string) => eventsGet(req("GET", `/api/admin/events${q}`, undefined, admin));
    const count = async (q: string) => ((await (await get(q)).json()) as unknown[]).length;
    expect(await count("")).toBe(200);
    expect(await count("?limit=-1")).toBe(1);
    expect(await count("?limit=0")).toBe(1);
    expect(await count("?limit=5")).toBe(5);
    expect(await count("?limit=100000")).toBe(1000);
    const page = (await (await get("?limit=3")).json()) as Array<{ id: number }>;
    const next = (await (await get(`?limit=3&before=${page[2]!.id}`)).json()) as Array<{ id: number }>;
    expect(next[0]!.id).toBe(page[2]!.id - 1);
    for (const bad of ["?limit=abc", "?limit=1.5", "?limit=1e3", "?before=0", "?before=-4", "?before=x", "?before=1e3"]) {
      expect((await get(bad)).status, bad).toBe(400);
    }
  });
});

describe("health-check answers", () => {
  let now = 1_800_000_000_000;
  beforeEach(() => {
    now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());
  const answer = (token: string, id: string) => diagPost(req("POST", "/api/agent/diagnostics", { id, ranAt: now, checks: [] }, bearer(token)));

  it("are only taken from an active gateway, for a request that was made, once", async () => {
    const admin = adminHeaders();
    const dc = meshSite("DC", "10.0.1.0/24", "10.0.250.2", "dc.example.com", 1);
    // Nobody asked.
    const unasked = await answer(dc.token, "123");
    expect(unasked.status).toBe(409);
    expect(getSite(dc.site.id)!.gateway!.diagJson).toBeNull();

    now += 1000;
    const { requestedAt } = requestDiagnostics(dc.site.id, "admin@example.com")!;
    now += 1000;
    expect((await answer(dc.token, "999")).status).toBe(409);
    expect((await answer(dc.token, String(requestedAt))).status).toBe(200);
    // Once only.
    expect((await answer(dc.token, String(requestedAt))).status).toBe(409);

    // A disabled gateway's answers are refused, even to a request made before.
    now += 1000;
    const again = String(requestDiagnostics(dc.site.id, "admin@example.com")!.requestedAt);
    await gatewayPatch(req("PATCH", `/api/admin/sites/${dc.site.id}/gateway`, { status: "disabled" }, admin), params({ id: dc.site.id }));
    now += 1000;
    expect((await answer(dc.token, again)).status).toBe(403);
    expect(JSON.parse(getSite(dc.site.id)!.gateway!.diagJson!).id).toBe(String(requestedAt));
  });
});
