/**
 * Cross-cutting generation properties: determinism, config-neutrality diffing,
 * port handling (nothing hardcoded), dynamic endpoints, keepalive placement.
 */
import { describe, expect, it } from "vitest";
import { generateAll } from "../lib/generator/index.js";
import { diffBundles, isConfigNeutral } from "../lib/diff.js";
import { FIXTURES, loadFixture, mutate } from "./helpers.js";

describe("determinism and config-neutrality", () => {
  it.each(FIXTURES)("%s: generating twice is byte-identical", (name) => {
    const a = generateAll(loadFixture(name));
    const b = generateAll(loadFixture(name));
    expect(isConfigNeutral(a, b)).toBe(true);
  });

  it("a port change shows up in the diff for every affected node", () => {
    const cfg = loadFixture("reference");
    const changed = mutate(cfg, (c) => (c.sites[0]!.gateway.listenPort = 51999));
    const diff = diffBundles(generateAll(cfg), generateAll(changed));
    const paths = diff.map((d) => d.path);
    // site-a's own interface changes, and every peer dials its new endpoint;
    // this is exactly why a port change is a coordinated transaction (§6).
    expect(paths).toContain("nodes/site-a/wg0.conf");
    expect(paths).toContain("nodes/site-b/wg0.conf");
    expect(paths).toContain("nodes/site-c/wg0.conf");
    expect(paths).toContain("clients/laptop/wg.conf");
    expect(paths).toContain("routers/site-a.txt");
    expect(diff.every((d) => d.kind === "changed")).toBe(true);
  });
});

describe("ports are configuration, never constants", () => {
  it("a mesh with only custom ports contains no 51820 anywhere", () => {
    const bundle = generateAll(loadFixture("custom-ports"));
    const everything = [
      ...Object.values(bundle.nodes).flatMap((n) => Object.values(n.files)),
      ...Object.values(bundle.clients).map((c) => c.config),
      ...Object.values(bundle.routers),
    ].join("\n");
    expect(everything).not.toContain("51820");
  });

  it("endpoints derive host:port from the owning node's listen_port", () => {
    const bundle = generateAll(loadFixture("custom-ports"));
    const siteC = bundle.nodes["site-c"]!.files["wg0.conf"]!;
    expect(siteC).toContain("Endpoint = 198.51.100.10:443");
    expect(siteC).toContain("Endpoint = vpn-b.example.net:51999");
    const client = bundle.clients["roam-1"]!.config;
    expect(client).toContain("Endpoint = vpn-b.example.net:51999");
    expect(client).toContain("Endpoint = 198.51.100.10:443");
  });

  it("router instructions use the actual configured port", () => {
    const bundle = generateAll(loadFixture("custom-ports"));
    expect(bundle.routers["site-a"]!).toContain("Forward UDP port 443 to 10.10.0.2");
    expect(bundle.routers["site-b"]!).toContain("Forward UDP port 51999 to 10.20.0.2");
    // NAT-bound site: no port-forward instruction at all.
    expect(bundle.routers["site-c"]!).not.toContain("Forward UDP port");
  });
});

describe("dynamic endpoints (§6)", () => {
  const bundle = generateAll(loadFixture("custom-ports"));

  it("a NAT-bound site has no Endpoint on its peers' side and keepalive on its own", () => {
    // Other nodes carry no Endpoint line for site-c — they learn it from handshakes.
    for (const id of ["site-a", "site-b"] as const) {
      const conf = bundle.nodes[id]!.files["wg0.conf"]!;
      const siteCBlock = conf.split("[Peer]").find((b) => b.includes("# site-c"))!;
      expect(siteCBlock).not.toContain("Endpoint");
      // Reachable gateways do not need keepalive.
      expect(siteCBlock).not.toContain("PersistentKeepalive");
    }
    // site-c itself dials out and keeps NAT mappings alive on every peer.
    const siteC = bundle.nodes["site-c"]!.files["wg0.conf"]!;
    const peerBlocks = siteC.split("[Peer]").slice(1);
    expect(peerBlocks.length).toBeGreaterThan(0);
    for (const block of peerBlocks) {
      expect(block).toContain("PersistentKeepalive = 25");
    }
  });

  it("hostname endpoints flag the reresolve-dns requirement", () => {
    // site-b's endpoint is a hostname; its peers need re-resolution.
    expect(bundle.nodes["site-a"]!.meta.needsReresolve).toBe(true);
    expect(bundle.nodes["site-c"]!.meta.needsReresolve).toBe(true);
    // site-b itself only dials literal IPs.
    expect(bundle.nodes["site-b"]!.meta.needsReresolve).toBe(false);
  });
});

describe("display names never appear in generated WireGuard config", () => {
  it("reference gateway names are absent", () => {
    const cfg = loadFixture("reference");
    const bundle = generateAll(cfg);
    for (const node of Object.values(bundle.nodes)) {
      expect(node.files["wg0.conf"]).not.toContain("Gateway A");
      expect(node.files["wg0.conf"]).not.toContain("Site A");
    }
    expect(bundle.clients["laptop"]!.config).not.toContain("Laptop");
  });
});

describe("transit AllowedIPs (hub shapes)", () => {
  it("single hub: spokes route the other spoke's prefixes via the hub", () => {
    const bundle = generateAll(loadFixture("single-hub"));
    const siteB = bundle.nodes["site-b"]!.files["wg0.conf"]!;
    const hubBlock = siteB.split("[Peer]").find((b) => b.includes("# site-a"))!;
    expect(hubBlock).toContain(
      "AllowedIPs = 10.99.0.1/32, 10.10.0.0/16, 10.99.0.3/32, 10.30.0.0/16, 10.99.1.10/32",
    );
    // The hub lists each spoke with exactly its own prefixes.
    const hub = bundle.nodes["site-a"]!.files["wg0.conf"]!;
    const spokeBlock = hub.split("[Peer]").find((b) => b.includes("# site-b"))!;
    expect(spokeBlock).toContain("AllowedIPs = 10.99.0.2/32, 10.20.0.0/16");
  });

  it("multi hub: the NAT site reaches the non-hub site via the first hub only", () => {
    const bundle = generateAll(loadFixture("multi-hub"));
    const siteD = bundle.nodes["site-d"]!.files["wg0.conf"]!;
    const viaA = siteD.split("[Peer]").find((b) => b.includes("# site-a"))!;
    expect(viaA).toContain("10.30.0.0/16"); // site-c LAN rides the site-a peer
    const viaB = siteD.split("[Peer]").find((b) => b.includes("# site-b"))!;
    expect(viaB).not.toContain("10.30.0.0/16"); // and never the second hub too
    // No peer entry for site-c at all on the NAT site.
    expect(siteD).not.toContain("# site-c");
  });
});
