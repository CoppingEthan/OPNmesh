import { describe, expect, it } from "vitest";
import { generateAll } from "@/core/generate";
import { generateClientConf, generateGatewayConf, CLIENT_PRIVATE_KEY_PLACEHOLDER } from "@/core/generate/wireguard";
import { generateNftables } from "@/core/generate/nftables";
import { generateRouterPlan } from "@/core/generate/router";
import { parsePeers, validateAll } from "@/core/validate";
import { scenarios } from "../fixtures/snapshots";

function peer(conf: string, label: string) {
  const p = parsePeers(conf).find((x) => x.comment === label);
  if (!p) throw new Error(`no peer "${label}" in:\n${conf}`);
  return p;
}

describe("generateAll", () => {
  it("is deterministic", () => {
    const a = generateAll(scenarios["hub-and-spoke"]!());
    const b = generateAll(scenarios["hub-and-spoke"]!());
    expect(a.hash).toBe(b.hash);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it("passes its own validators in every scenario except the one with no hub", () => {
    for (const [name, make] of Object.entries(scenarios)) {
      const snap = make();
      const bundle = generateAll(snap);
      const errors = validateAll(snap, bundle).filter((f) => f.level === "error");
      if (name === "no-hub") expect(errors.map((e) => e.code)).toEqual(["unreachable-pair"]);
      else expect(errors, name).toEqual([]);
    }
  });
  it("never contains a private key or a default route", () => {
    for (const make of Object.values(scenarios)) {
      const bundle = generateAll(make());
      for (const g of Object.values(bundle.gateways)) {
        for (const text of Object.values(g.files)) {
          expect(text).not.toMatch(/PrivateKey/);
          expect(text).not.toMatch(/0\.0\.0\.0\/0/);
        }
      }
      for (const c of Object.values(bundle.clients)) {
        expect(c.conf).toContain(`PrivateKey = ${CLIENT_PRIVATE_KEY_PLACEHOLDER}`);
        expect(c.conf).not.toMatch(/0\.0\.0\.0\/0/);
      }
    }
  });
  it("skips sites without a gateway and disabled clients", () => {
    const bundle = generateAll(scenarios["pending-site"]!());
    expect(Object.keys(bundle.gateways)).toEqual(["gw-dc"]);
    const pol = generateAll(scenarios["policies"]!());
    expect(Object.keys(pol.clients)).not.toContain("client-old-laptop");
    for (const g of Object.values(pol.gateways)) expect(g.files["wireguard.conf"]).not.toContain("old-laptop");
  });
});

describe("gateway AllowedIPs", () => {
  it("carries the peer's tunnel address and shared LANs only", () => {
    const snap = scenarios["two-sites"]!();
    const dc = generateGatewayConf(snap, "site-dc");
    expect(peer(dc, "site: office").allowedIps).toEqual(["10.99.0.2/32", "192.168.20.0/24", "192.168.30.0/24"]);
    expect(peer(dc, "client: alice-laptop").allowedIps).toEqual(["10.99.1.10/32"]);
    expect(dc).toContain("Endpoint = 203.0.113.20:51820");
    expect(dc).not.toContain("PersistentKeepalive");
  });
  it("hub carries transit destinations; spokes keep alive", () => {
    const snap = scenarios["two-spokes"]!();
    const north = generateGatewayConf(snap, "site-shop-north");
    expect(peer(north, "site: dc").allowedIps).toEqual([
      "10.99.0.1/32",
      "10.0.1.0/24",
      "10.99.0.4/32",
      "10.32.0.0/24",
      "10.99.1.10/32",
    ]);
    expect(peer(north, "site: office").allowedIps).toEqual(["10.99.0.2/32", "192.168.20.0/24"]);
    expect(north).toContain("PersistentKeepalive = 25");
    expect(parsePeers(north).map((p) => p.comment)).toEqual(["site: dc", "site: office"]);

    const dc = generateGatewayConf(snap, "site-dc");
    expect(peer(dc, "site: shop-north").allowedIps).toEqual(["10.99.0.3/32", "10.31.0.0/24"]);
    expect(dc).not.toContain("Endpoint = shop-north");
  });
  it("omits unshared LANs everywhere", () => {
    const snap = scenarios["policies"]!();
    const office = generateGatewayConf(snap, "site-office");
    expect(office).not.toContain("10.0.200.0/24");
    expect(generateNftables(snap, "site-office")).not.toContain("10.0.200.0/24");
    expect(generateClientConf(snap, "client-support-pc")).not.toContain("10.0.200.0/24");
  });
  it("routes a restricted client's /32 only where it belongs", () => {
    const snap = scenarios["policies"]!();
    const dc = generateGatewayConf(snap, "site-dc");
    // dc is the relay for the depot tablet, so the tablet is a direct peer of dc...
    expect(peer(dc, "client: depot-tablet").allowedIps).toEqual(["10.99.1.21/32"]);
    // ...but the contractor (office only) is unknown to dc.
    expect(dc).not.toContain("contractor");
    const depot = generateGatewayConf(snap, "site-depot");
    expect(peer(depot, "site: dc").allowedIps).toContain("10.99.1.21/32");
    expect(peer(depot, "site: dc").allowedIps).not.toContain("10.99.1.20/32");
    expect(peer(depot, "site: office").allowedIps).not.toContain("10.99.1.21/32");
  });
});

describe("client configs", () => {
  it("peer per reachable site, outbound-only sites via the relay, DNS from the relay", () => {
    const snap = scenarios["hub-and-spoke"]!();
    const alice = generateClientConf(snap, "client-alice-laptop");
    expect(peer(alice, "site: dc").allowedIps).toEqual(["10.99.0.1/32", "10.0.1.0/24", "10.99.0.3/32", "10.30.0.0/24"]);
    expect(peer(alice, "site: office").allowedIps).toEqual(["10.99.0.2/32", "192.168.20.0/24"]);
    const bob = generateClientConf(snap, "client-bob-phone");
    expect(peer(bob, "site: office").allowedIps).toContain("10.30.0.0/24");
    expect(peer(bob, "site: dc").allowedIps).not.toContain("10.30.0.0/24");
    expect(alice).toContain("PersistentKeepalive = 25");
    expect(alice).toContain("Address = 10.99.1.10/32");
  });
  it("adds DNS when a site declares it", () => {
    const snap = scenarios["two-sites"]!();
    expect(generateClientConf(snap, "client-alice-laptop")).toContain("DNS = 10.0.1.53, corp.example");
  });
  it("restricted clients see only their sites", () => {
    const snap = scenarios["policies"]!();
    const contractor = generateClientConf(snap, "client-contractor");
    expect(parsePeers(contractor).map((p) => p.comment)).toEqual(["site: office"]);
    expect(contractor).not.toContain("10.0.1.0/24");
    const tablet = generateClientConf(snap, "client-depot-tablet");
    expect(parsePeers(tablet).map((p) => p.comment)).toEqual(["site: dc"]);
    expect(peer(tablet, "site: dc").allowedIps).toEqual(["10.99.0.3/32", "10.40.0.0/24"]);
  });
});

describe("nftables", () => {
  it("counts every pair in both directions and accepts exactly the routed traffic", () => {
    const snap = scenarios["two-spokes"]!();
    const dc = generateNftables(snap, "site-dc");
    expect(dc).toContain("counter c_dc_to_office {}");
    expect(dc).toContain("counter c_shop_north_to_shop_south {}");
    expect(dc).toContain('ip saddr @lan_shop_north ip daddr @lan_shop_south counter name "c_shop_north_to_shop_south"');
    // Counters must precede the established/related accept or they only see the first packet.
    expect(dc.indexOf('counter name "c_dc_to_office"')).toBeLessThan(dc.indexOf("ct state established,related accept"));
    expect(dc).toContain('iifname "opnmesh0" oifname "opnmesh0" ip saddr @lan_shop_north ip daddr @lan_shop_south accept');
    expect(dc).toContain("policy drop");
    expect(dc).not.toContain("masquerade");
    const office = generateNftables(snap, "site-office");
    expect(office).not.toContain("c_shop_north_to_shop_south");
    expect(office).not.toContain('oifname "opnmesh0" ip saddr @lan_shop_north');
  });
  it("isolates clients and honours allow-inbound and restrictions", () => {
    const snap = scenarios["policies"]!();
    const dc = generateNftables(snap, "site-dc");
    expect(dc).toContain('oifname "opnmesh0" ip daddr 10.99.1.22 accept');
    expect(dc).toContain('oifname "opnmesh0" ip daddr @clients ct state new drop');
    expect(dc).toContain("elements = { 10.99.1.22/32 }"); // clients_open: only the unrestricted, enabled, entering client
    expect(dc).toContain('iifname "opnmesh0" oifname "opnmesh0" ip saddr 10.99.1.21 ip daddr @lan_depot accept');
    expect(dc).not.toContain("ip saddr 10.99.1.21 ip daddr @lan_dc accept");
    expect(dc).not.toContain("10.99.1.20");
    expect(dc).not.toContain("10.99.1.23");
  });
  it("lets relayed clients into an outbound-only site", () => {
    // The warehouse dials out only; clients reach it through the hub, so its
    // firewall must accept them even though they are not its direct peers.
    const snap = scenarios["hub-and-spoke"]!();
    const warehouse = generateNftables(snap, "site-warehouse");
    expect(warehouse).toContain("set clients_open");
    expect(warehouse).toContain("elements = { 10.99.1.10/32, 10.99.1.11/32 }");
    expect(warehouse).toContain('iifname "opnmesh0" oifname != "opnmesh0" ip saddr @clients_open ip daddr @lan_warehouse accept');
    const pol = scenarios["policies"]!();
    const depot = generateNftables(pol, "site-depot");
    expect(depot).toContain('iifname "opnmesh0" oifname != "opnmesh0" ip saddr 10.99.1.21 ip daddr @lan_depot accept');
    expect(depot).not.toContain("10.99.1.20"); // the office-only contractor never reaches the depot
  });
  it("masquerades only on masquerade-layout sites", () => {
    const snap = scenarios["hub-and-spoke"]!();
    expect(generateNftables(snap, "site-warehouse")).toContain('iifname "opnmesh0" oifname != "opnmesh0" masquerade');
    expect(generateNftables(snap, "site-dc")).not.toContain("masquerade");
    expect(generateNftables(snap, "site-office")).not.toContain("masquerade");
  });
  it("uses the configured interface name", () => {
    const snap = scenarios["two-sites"]!();
    snap.settings.interfaceName = "wg7";
    expect(generateNftables(snap, "site-dc")).toContain('oifname "wg7" tcp flags syn');
    expect(generateNftables(snap, "site-dc")).not.toContain("opnmesh0");
  });
});

describe("router plans", () => {
  it("lists every remote shared subnet plus the tunnel ranges", () => {
    const snap = scenarios["hub-and-spoke"]!();
    const office = generateRouterPlan(snap, "site-office");
    expect(office.nextHop).toBe("192.168.20.2");
    expect(office.routes.map((r) => r.cidr)).toEqual(["10.0.1.0/24", "10.30.0.0/24", "10.99.0.0/24", "10.99.1.0/24"]);
    expect(office.portForward).toEqual({ protocol: "udp", port: 51820, toIp: "192.168.20.2" });
    expect(office.allStatesPolicy?.destinations).toEqual(office.routes.map((r) => r.cidr));
    const warehouse = generateRouterPlan(snap, "site-warehouse");
    expect(warehouse.portForward).toBeNull();
    expect(warehouse.routes.every((r) => !r.required)).toBe(true);
    expect(warehouse.allStatesPolicy).toBeNull();
    const dc = generateRouterPlan(snap, "site-dc");
    expect(dc.allStatesPolicy).toBeNull();
  });
});
