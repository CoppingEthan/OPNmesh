/**
 * The controller's own defences against a hostile client: login throttling
 * under concurrency and from many addresses, the device cookie, the setup
 * race, CSRF checks, the request-body cap, the live stream's limits and the
 * sealing secret's safety checks.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { freshDb } from "./helpers";
import { changePassword, completeSetup, deviceFromRequest, login, logout, sessionFromToken, setupCode, throttleKey } from "@/server/auth";
import { env, setEnvForTests, type Env } from "@/server/env";
import { MAX_BODY, parseBody, rateLimited, resetRateLimitsForTests, sameOrigin } from "@/server/http";
import { updateSettings } from "@/server/settings";
import { POST as loginPost } from "../../app/api/admin/login/route";
import { GET as liveGet } from "../../app/api/admin/live/route";

const PASSWORD = "correct horse battery";

beforeEach(() => {
  freshDb();
  resetRateLimitsForTests();
});

async function admin(): Promise<void> {
  await completeSetup({ code: setupCode(), email: "admin@example.com", password: PASSWORD });
}

function loginReq(password: string, headers: Record<string, string> = {}): Request {
  return new Request("http://controller.test/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", host: "controller.test", ...headers },
    body: JSON.stringify({ email: "admin@example.com", password }),
  });
}

describe("login throttling", () => {
  it("charges concurrent guesses before checking them, so a burst cannot overrun the limit", async () => {
    await admin();
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => login("admin@example.com", i === 29 ? PASSWORD : "wrong guess " + i, "203.0.113.7")));
    const reasons = results.map((r) => (r.status === "rejected" ? String((r.reason as Error).message) : "signed in"));
    expect(reasons.filter((m) => m.includes("incorrect")).length).toBeLessThanOrEqual(10);
    expect(reasons.filter((m) => m.includes("too many")).length).toBeGreaterThanOrEqual(19);
    expect(reasons).not.toContain("signed in"); // the right password arrived while the source was already spent
  }, 60_000);

  it("gives a successful attempt back and counts an IPv6 client by its /64", async () => {
    await admin();
    for (let i = 0; i < 12; i++) await login("admin@example.com", PASSWORD, "198.51.100.1");
    await expect(login("admin@example.com", PASSWORD, "198.51.100.1")).resolves.toBeTypeOf("string");

    for (let i = 0; i < 10; i++) await expect(login("admin@example.com", "wrong", `2001:db8:1:2::${i + 1}`)).rejects.toThrow(/incorrect/);
    await expect(login("admin@example.com", PASSWORD, "2001:db8:1:2:ffff::9")).rejects.toThrow(/too many/);
    await expect(login("admin@example.com", PASSWORD, "2001:db8:1:3::1")).resolves.toBeTypeOf("string");
  }, 60_000);

  it("keeps a browser that signed in before working when the global cap is hit", async () => {
    await admin();
    const ok = await loginPost(loginReq(PASSWORD));
    expect(ok.status).toBe(200);
    const cookies = ok.headers.getSetCookie();
    expect(cookies[1]).toMatch(/^opnmesh_device=[^;]+; Path=\/api\/admin\/login; HttpOnly; SameSite=Strict/);
    const device = cookies[1]!.split(";")[0]!;

    // Ten addresses, ten wrong passwords each: the global cap.
    for (let s = 0; s < 10; s++) {
      for (let i = 0; i < 10; i++) await expect(login("admin@example.com", "wrong", `192.0.2.${s + 1}`)).rejects.toThrow(/incorrect/);
    }
    await expect(login("admin@example.com", PASSWORD, "198.51.100.50")).rejects.toThrow(/too many/);
    expect((await loginPost(loginReq(PASSWORD))).status).toBe(429);
    expect((await loginPost(loginReq(PASSWORD, { cookie: device }))).status).toBe(200);
    // A forged or altered cookie counts for nothing.
    const forged = device.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect(deviceFromRequest(new Request("http://x/", { headers: { cookie: forged } }))).toBeNull();
    expect((await loginPost(loginReq(PASSWORD, { cookie: forged }))).status).toBe(429);
  }, 120_000);

  it("groups addresses for throttling", () => {
    expect(throttleKey("2001:db8:0:1::5")).toBe("2001:db8:0:1::/64");
    expect(throttleKey("2001:0db8:0000:0001:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:0:1::/64");
    expect(throttleKey("::1")).toBe("0:0:0:0::/64");
    expect(throttleKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(throttleKey("192.0.2.1")).toBe("192.0.2.1");
    expect(throttleKey("direct")).toBe("direct");
  });

  it("limits current-password guesses on a stolen session", async () => {
    await admin();
    const s = sessionFromToken(await login("admin@example.com", PASSWORD))!;
    for (let i = 0; i < 10; i++) await expect(changePassword(s.userId, "guess " + i, "a brand new password")).rejects.toThrow(/incorrect/);
    await expect(changePassword(s.userId, PASSWORD, "a brand new password")).rejects.toThrow(/too many/);
  }, 60_000);
});

describe("first-run setup", () => {
  it("creates exactly one admin when two requests race, then retires the code file", async () => {
    const code = setupCode();
    expect(existsSync(join(env().dataDir, "setup-code"))).toBe(true);
    const results = await Promise.allSettled([
      completeSetup({ code, email: "admin@example.com", password: PASSWORD }),
      completeSetup({ code, email: "intruder@example.com", password: PASSWORD }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/already/);
    expect(existsSync(join(env().dataDir, "setup-code"))).toBe(false);
  }, 30_000);

  it("has no global cap, so nobody can stop the owner finishing setup", async () => {
    for (let s = 0; s < 12; s++) {
      for (let i = 0; i < 10; i++) {
        await expect(completeSetup({ code: "WRONGWRONG12", email: "x@example.com", password: PASSWORD }, `192.0.2.${s + 1}`)).rejects.toThrow(/does not match/);
      }
    }
    await expect(completeSetup({ code: "WRONGWRONG12", email: "x@example.com", password: PASSWORD }, "192.0.2.1")).rejects.toThrow(/too many/);
    await completeSetup({ code: setupCode(), email: "admin@example.com", password: PASSWORD }, "198.51.100.9");
  }, 30_000);
});

describe("same-origin check", () => {
  const post = (headers: Record<string, string>) => new Request("http://controller.test/api/admin/sites", { method: "POST", headers: { host: "controller.test", ...headers } });

  it("accepts this controller only, by public URL or by the addressed host with the right scheme", () => {
    setEnvForTests({ publicUrl: "https://mesh.example.com", trustProxy: 0 });
    expect(sameOrigin(post({ origin: "https://mesh.example.com" }))).toBe(true);
    expect(sameOrigin(post({ origin: "https://controller.test" }))).toBe(true);
    expect(sameOrigin(post({ origin: "http://controller.test" }))).toBe(false); // scheme must match
    expect(sameOrigin(post({ origin: "https://evil.example" }))).toBe(false);
    expect(sameOrigin(post({ origin: "null" }))).toBe(false);
    // X-Forwarded-Host means nothing without a configured proxy…
    expect(sameOrigin(post({ origin: "https://evil.example", "x-forwarded-host": "evil.example" }))).toBe(false);
    // …and is the proxy's word with one.
    setEnvForTests({ trustProxy: 1 });
    expect(sameOrigin(post({ origin: "https://proxied.example", "x-forwarded-host": "proxied.example" }))).toBe(true);
  });

  it("follows the Settings override of the public URL", () => {
    setEnvForTests({ publicUrl: "https://mesh.example.com", trustProxy: 0, insecureHttp: false });
    updateSettings({ publicUrl: "https://mesh2.example.com" });
    expect(sameOrigin(post({ origin: "https://mesh2.example.com" }))).toBe(true);
    expect(() => updateSettings({ publicUrl: "https://mesh.example.com$(id)" })).toThrow(/only letters, digits/);
  });

  it("without Origin, refuses what a browser marks as cross-site and allows non-browser clients", () => {
    expect(sameOrigin(post({}))).toBe(true);
    expect(sameOrigin(post({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(post({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOrigin(post({ "sec-fetch-site": "same-site" }))).toBe(false);
  });
});

describe("request bodies", () => {
  it("refuses a chunked body over the limit without reading all of it", async () => {
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        if (sent > 50 * MAX_BODY) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const req = new Request("http://controller.test/api/agent/enrol", { method: "POST", body, duplex: "half" } as RequestInit);
    await expect(parseBody(req, z.object({}))).rejects.toMatchObject({ status: 413 });
    expect(sent).toBeLessThan(2 * MAX_BODY);
  });

  it("still parses a normal body, and refuses a large declared length at once", async () => {
    const ok = new Request("http://x/", { method: "POST", body: JSON.stringify({ a: 1 }) });
    await expect(parseBody(ok, z.object({ a: z.number() }))).resolves.toEqual({ a: 1 });
    const big = new Request("http://x/", { method: "POST", headers: { "content-length": String(MAX_BODY + 1) }, body: "{}" });
    await expect(parseBody(big, z.object({}))).rejects.toMatchObject({ status: 413 });
  });
});

describe("public endpoint rate limits", () => {
  it("evicts finished windows, then the oldest, instead of resetting every limit when the table fills", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 50_000; i++) rateLimited(`spent-${i}`, 20, 1);
      vi.advanceTimersByTime(10);
      for (let i = 0; i < 25; i++) rateLimited("limited", 20, 60_000);
      rateLimited("one-more", 20, 60_000); // over capacity: the finished windows go
      expect(rateLimited("limited", 20, 60_000)).toBe(true);

      for (let i = 0; i < 50_000; i++) rateLimited(`live-${i}`, 20, 60_000);
      for (let i = 0; i < 25; i++) rateLimited("newest", 20, 60_000); // nothing has finished: the oldest go
      expect(rateLimited("newest", 20, 60_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("live stream", () => {
  async function session(): Promise<{ cookie: string; token: string }> {
    await admin();
    const token = await login("admin@example.com", PASSWORD);
    return { cookie: `opnmesh_session=${token}`, token };
  }
  const liveReq = (cookie: string) => new Request("http://controller.test/api/admin/live", { headers: { cookie, host: "controller.test" } });

  it("ends when the session ends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { cookie, token } = await session();
      const res = await liveGet(liveReq(cookie));
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain("retry:");
      logout(token);
      vi.advanceTimersByTime(6000);
      let done = false;
      for (let i = 0; i < 20 && !done; i++) done = (await reader.read()).done;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("caps concurrent streams per session", async () => {
    const { cookie } = await session();
    const streams: Response[] = [];
    for (let i = 0; i < 8; i++) streams.push(await liveGet(liveReq(cookie)));
    expect(streams.every((r) => r.status === 200)).toBe(true);
    expect((await liveGet(liveReq(cookie))).status).toBe(429);
    await streams[0]!.body!.cancel();
    expect((await liveGet(liveReq(cookie))).status).toBe(200);
    for (const r of streams.slice(1)) await r.body!.cancel();
  }, 30_000);
});

describe("sealing secret", () => {
  const g = globalThis as unknown as { __opnmeshEnv?: Env };
  let saved: Env | undefined;
  let dir = "";
  const savedEnv = { data: process.env["OPNMESH_DATA_DIR"], secret: process.env["OPNMESH_SECRET"], db: process.env["OPNMESH_DB_PATH"] };

  beforeEach(() => {
    saved = g.__opnmeshEnv;
    g.__opnmeshEnv = undefined;
    dir = mkdtempSync(join(tmpdir(), "opnmesh-secret-"));
    process.env["OPNMESH_DATA_DIR"] = dir;
    delete process.env["OPNMESH_SECRET"];
    delete process.env["OPNMESH_DB_PATH"];
  });
  afterEach(() => {
    g.__opnmeshEnv = saved;
    for (const [k, v] of [
      ["OPNMESH_DATA_DIR", savedEnv.data],
      ["OPNMESH_SECRET", savedEnv.secret],
      ["OPNMESH_DB_PATH", savedEnv.db],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("is created on a fresh install", () => {
    expect(env().secret).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(dir, "secret.key"))).toBe(true);
  });

  it("is never silently replaced next to an existing database", () => {
    writeFileSync(join(dir, "opnmesh.db"), "");
    expect(() => env()).toThrow(/secret.key is missing/);
    writeFileSync(join(dir, "secret.key"), "a1\n");
    expect(() => env()).toThrow(/empty or damaged/);
  });

  it("refuses a short OPNMESH_SECRET", () => {
    process.env["OPNMESH_SECRET"] = "short";
    expect(() => env()).toThrow(/at least 32/);
  });
});
