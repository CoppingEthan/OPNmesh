import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { ConfigError, loadSitesYaml } from "../lib/schema.js";
import { fixtureText, loadFixture } from "./helpers.js";

describe("sites.yml schema", () => {
  it("accepts the committed example config", () => {
    const text = readFileSync(join(process.cwd(), "config", "sites.example.yml"), "utf8");
    const cfg = loadSitesYaml(text);
    expect(cfg.sites.map((s) => s.id)).toEqual(["site-a", "site-b", "site-c"]);
    expect(cfg.network.defaultListenPort).toBe(51820);
  });

  it("accepts all fixtures", () => {
    expect(() => loadFixture("reference")).not.toThrow();
    expect(() => loadFixture("custom-ports")).not.toThrow();
    expect(() => loadFixture("single-hub")).not.toThrow();
    expect(() => loadFixture("multi-hub")).not.toThrow();
  });

  it("rejects unknown keys (typos fail loudly)", () => {
    const text = fixtureText("reference").replace("policy:", "polcy:");
    expect(() => loadSitesYaml(text)).toThrow(ZodError);
  });

  it("rejects any private_key field — private keys never enter sites.yml", () => {
    // The injected line is assembled at runtime so the repo itself stays
    // clean under scripts/check-no-keys.sh.
    const keyish = "a".repeat(43) + "=";
    const publicLine = `public_key: ${keyish}`;
    const text = fixtureText("reference").replace(
      publicLine,
      `${publicLine}\n      ${["private", "key"].join("_")}: ${keyish}`,
    );
    expect(() => loadSitesYaml(text)).toThrow(ZodError);
  });

  it("rejects an endpoint that embeds a port — ports come from listen_port", () => {
    const text = fixtureText("reference").replace(
      "endpoint: 198.51.100.10",
      'endpoint: "198.51.100.10:51820"',
    );
    expect(() => loadSitesYaml(text)).toThrow(ZodError);
  });

  it("rejects malformed public keys", () => {
    const text = fixtureText("reference").replace(
      "public_key: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
      "public_key: not-a-key",
    );
    expect(() => loadSitesYaml(text)).toThrow(ZodError);
  });

  it("requires hubs for hub topologies", () => {
    const text = fixtureText("multi-hub").replace(/^  hubs:\n(    - site-[ab]\n)+/m, "");
    expect(() => loadSitesYaml(text)).toThrow(ConfigError);
  });

  it("rejects a NAT-bound hub", () => {
    const text = fixtureText("single-hub")
      .replace("endpoint: 198.51.100.10", "endpoint: null");
    expect(() => loadSitesYaml(text)).toThrow(/hub "site-a" has no endpoint/);
  });

  it("rejects a client entry point without an inbound endpoint, with a plain-English reason", () => {
    const text = fixtureText("single-hub").replace(
      "home_site: site-b",
      "home_site: site-b\n    entry_points:\n      - site-b",
    );
    expect(() => loadSitesYaml(text)).toThrow(/no inbound UDP endpoint/);
  });

  it("defaults client entry points to every eligible site, in site order", () => {
    const cfg = loadFixture("reference");
    expect(cfg.clients[0]!.entryPoints).toEqual(["site-a", "site-b", "site-c"]);
    const hub = loadFixture("single-hub");
    expect(hub.clients[0]!.entryPoints).toEqual(["site-a"]);
  });

  it("resolves per-node port and MTU defaults", () => {
    const cfg = loadFixture("custom-ports");
    const byId = Object.fromEntries(cfg.sites.map((s) => [s.id, s]));
    expect(byId["site-a"]!.gateway.listenPort).toBe(443);
    expect(byId["site-b"]!.gateway.listenPort).toBe(51999);
    expect(byId["site-c"]!.gateway.listenPort).toBe(48651); // network default, not 51820
    expect(byId["site-a"]!.gateway.mtu).toBe(1380);
    expect(byId["site-b"]!.gateway.mtu).toBe(1420);
    expect(byId["site-b"]!.gateway.endpointIsHostname).toBe(true);
    expect(byId["site-a"]!.gateway.endpointIsHostname).toBe(false);
  });
});
