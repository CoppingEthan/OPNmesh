/**
 * Multi-VLAN behaviour: a site with several segments advertises all of them,
 * management segments pick up ACLs automatically, and guest segments are
 * unroutable across the mesh by two independent mechanisms (absent from every
 * AllowedIPs, and dropped in nftables).
 */
import { describe, expect, it } from "vitest";
import { generateAll } from "../lib/generator/index.js";
import { runValidators } from "../lib/validators/index.js";
import { loadFixture } from "./helpers.js";

const GUEST = "192.168.1.0/24";

describe("multi-VLAN sites", () => {
  const cfg = loadFixture("multi-vlan");
  const bundle = generateAll(cfg);

  it("validates clean", () => {
    expect(runValidators(cfg, bundle).filter((f) => f.level === "error")).toEqual([]);
  });

  it("resolves the single-subnet shorthand and the multi-VLAN list the same way", () => {
    const a = cfg.sites.find((s) => s.id === "site-a")!;
    const b = cfg.sites.find((s) => s.id === "site-b")!;
    expect(a.lans).toHaveLength(5);
    expect(b.lans).toEqual([
      { cidr: "10.20.0.0/16", name: undefined, vlan: undefined, role: "standard" },
    ]);
    expect(b.advertised).toEqual(["10.20.0.0/16"]);
  });

  it("advertises every non-guest segment to peers, and no guest segment", () => {
    const a = cfg.sites.find((s) => s.id === "site-a")!;
    expect(a.advertised).toEqual([
      "10.10.10.0/24",
      "10.10.20.0/24",
      "10.10.30.0/24",
      "10.10.99.0/24",
    ]);
    expect(a.advertised).not.toContain(GUEST);

    // Peers carry all four of site-a's routed subnets on the site-a peer entry.
    const fromB = bundle.nodes["site-b"]!.files["wg0.conf"]!;
    const peerA = fromB.split("[Peer]").find((b) => b.includes("# site-a"))!;
    for (const net of a.advertised) expect(peerA).toContain(net);
  });

  it("a guest VLAN appears in NO generated AllowedIPs anywhere", () => {
    for (const node of Object.values(bundle.nodes)) {
      const conf = node.files["wg0.conf"]!;
      for (const line of conf.split("\n")) {
        if (line.trim().startsWith("AllowedIPs")) {
          expect(line, "guest network leaked into AllowedIPs").not.toContain(GUEST);
        }
      }
    }
    for (const { config } of Object.values(bundle.clients)) {
      expect(config).not.toContain(GUEST);
    }
  });

  it("a guest VLAN is dropped in both directions on its own gateway", () => {
    const nft = bundle.nodes["site-a"]!.files["nftables.conf"]!;
    expect(nft).toContain(`elements = { ${GUEST} }`);
    expect(nft).toContain('oifname "wg0" ip saddr @guest_nets drop');
    expect(nft).toContain('iifname "wg0" ip daddr @guest_nets drop');
    // site-b has no guest network, so no guest rules at all.
    expect(bundle.nodes["site-b"]!.files["nftables.conf"]).not.toContain("guest_nets");
  });

  it("guest networks are never handed to a site router as a mesh route", () => {
    const routes = bundle.routers["site-b"]!;
    expect(routes).not.toContain(`${GUEST} via`);
    // ...but site-a's own instructions say plainly that it stays local.
    expect(bundle.routers["site-a"]!).toContain("stays local to this site");
  });

  it("management VLANs join the ACL set automatically without restating them", () => {
    expect(cfg.policy!.management.managementDestinations).toEqual(
      expect.arrayContaining(["10.10.99.0/24", "10.30.99.0/24"]),
    );
    const nft = bundle.nodes["site-c"]!.files["nftables.conf"]!;
    expect(nft).toContain("set mgmt_destinations");
    expect(nft).toContain("10.10.99.0/24");
    expect(nft).toContain("ip saddr @admin_sources ip daddr @mgmt_destinations ct state new accept");
    // Management may never initiate across the mesh.
    expect(nft).toContain('oifname "wg0" ip saddr @mgmt_destinations ct state new drop');
  });

  it("the traffic matrix stays one counter per site pair regardless of VLAN count", () => {
    const nft = bundle.nodes["site-a"]!.files["nftables.conf"]!;
    const counters = [...nft.matchAll(/counter name "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(counters)).toEqual(
      new Set(["cnt_site_a_to_site_b", "cnt_site_b_to_site_a", "cnt_site_a_to_site_c", "cnt_site_c_to_site_a"]),
    );
    // Matching is by per-site set, so five VLANs cost one rule, not five.
    expect(nft).toContain("set nets_site_a");
    expect(nft).toContain("ip saddr @nets_site_a ip daddr @nets_site_b");
  });

  it("router instructions list every remote VLAN with its name", () => {
    const routes = bundle.routers["site-b"]!;
    expect(routes).toContain("10.10.10.0/24 via 10.20.0.2    # site-a Staff vlan 10");
    expect(routes).toContain("10.10.99.0/24 via 10.20.0.2    # site-a Management vlan 99");
    expect(routes).toContain("10.30.40.0/24 via 10.20.0.2    # site-c Scanners vlan 40");
  });

  it("clients reach every advertised VLAN at every site", () => {
    const conf = bundle.clients["laptop"]!.config;
    for (const site of cfg.sites) {
      for (const net of site.advertised) expect(conf).toContain(net);
    }
    expect(conf).not.toContain(GUEST);
  });
});
