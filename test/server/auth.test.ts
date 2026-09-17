import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./helpers";
import { AuthError, changePassword, completeSetup, login, logout, needsSetup, requestSource, sessionCookie, sessionFromToken, setupCode, tokenFromRequest } from "@/server/auth";
import { proxyHops, setEnvForTests } from "@/server/env";

beforeEach(() => {
  freshDb();
});

describe("setup and login", () => {
  it("requires the setup code, then logs in with a session", async () => {
    expect(needsSetup()).toBe(true);
    await expect(completeSetup({ code: "WRONG", email: "admin@example.com", password: "correct horse battery" })).rejects.toThrow(AuthError);
    await expect(completeSetup({ code: setupCode(), email: "bad", password: "correct horse battery" })).rejects.toThrow(/email/);
    await expect(completeSetup({ code: setupCode(), email: "admin@example.com", password: "short" })).rejects.toThrow(/12 characters/);
    await completeSetup({ code: setupCode().toLowerCase(), email: "admin@example.com", password: "correct horse battery" });
    expect(needsSetup()).toBe(false);
    await expect(completeSetup({ code: setupCode(), email: "x@example.com", password: "correct horse battery" })).rejects.toThrow(/already/);

    await expect(login("admin@example.com", "wrong password!")).rejects.toThrow(/incorrect/);
    await expect(login("nobody@example.com", "correct horse battery")).rejects.toThrow(/incorrect/);
    const token = await login("Admin@Example.com", "correct horse battery");
    const s = sessionFromToken(token);
    expect(s?.email).toBe("admin@example.com");
    expect(sessionFromToken("garbage")).toBeNull();

    const req = new Request("http://x/", { headers: { cookie: `a=b; ${sessionCookie(token).split(";")[0]}` } });
    expect(tokenFromRequest(req)).toBe(token);
    expect(sessionCookie(null)).toContain("Max-Age=0");

    await changePassword(s!.userId, "correct horse battery", "an even better password");
    expect(sessionFromToken(token)).toBeNull(); // sessions invalidated on password change
    const t2 = await login("admin@example.com", "an even better password");
    logout(t2);
    expect(sessionFromToken(t2)).toBeNull();
  }, 30_000);

  it("throttles repeated failures per source", async () => {
    await completeSetup({ code: setupCode(), email: "admin@example.com", password: "correct horse battery" });
    for (let i = 0; i < 10; i++) {
      await expect(login("admin@example.com", "wrong", "1.2.3.4")).rejects.toThrow();
    }
    await expect(login("admin@example.com", "correct horse battery", "1.2.3.4")).rejects.toThrow(/too many/);
    // Another source is unaffected.
    await expect(login("admin@example.com", "correct horse battery", "5.6.7.8")).resolves.toBeTypeOf("string");
  }, 60_000);
});

describe("client address behind reverse proxies", () => {
  const withXff = (...values: string[]) => {
    const h = new Headers();
    for (const v of values) h.append("x-forwarded-for", v);
    return new Request("http://controller.test/", { headers: h });
  };

  it("ignores forwarding headers unless a proxy is configured", () => {
    setEnvForTests({ trustProxy: 0 });
    expect(requestSource(withXff("198.51.100.7"))).toBe("direct");
    expect(requestSource(new Request("http://controller.test/"))).toBe("direct");
  });

  it("takes the address the nearest proxy added, not one the client forged", () => {
    setEnvForTests({ trustProxy: 1 });
    expect(requestSource(withXff("198.51.100.7"))).toBe("198.51.100.7");
    // A proxy that appends to a client-supplied header.
    expect(requestSource(withXff("203.0.113.99, 198.51.100.7"))).toBe("198.51.100.7");
    // A proxy that passes the client's header through and adds its own line.
    expect(requestSource(withXff("203.0.113.99", "198.51.100.7"))).toBe("198.51.100.7");
    expect(requestSource(withXff(" 203.0.113.99 ,, 198.51.100.7 "))).toBe("198.51.100.7");
    expect(requestSource(new Request("http://controller.test/"))).toBe("direct");
  });

  it("counts from the right when several proxies are in front", () => {
    setEnvForTests({ trustProxy: 2 });
    // client -> CDN -> proxy: the CDN recorded the client, the proxy recorded the CDN.
    expect(requestSource(withXff("203.0.113.99, 198.51.100.7, 192.0.2.10"))).toBe("198.51.100.7");
    // Fewer entries than proxies: the leftmost is the best there is.
    expect(requestSource(withXff("198.51.100.7"))).toBe("198.51.100.7");
  });

  it("reads the proxy count leniently", () => {
    expect(proxyHops("1")).toBe(1);
    expect(proxyHops(" 2 ")).toBe(2);
    expect(proxyHops("0")).toBe(0);
    for (const bad of [undefined, "", "yes", "true", "-1", "1.5", "99"]) expect(proxyHops(bad), String(bad)).toBe(0);
  });
});
