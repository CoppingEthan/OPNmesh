/**
 * Which configs an error finding holds back, the public-address warning for
 * shared networks, and the address classes behind them.
 */
import { describe, expect, it } from "vitest";
import { generateAll } from "@/core/generate";
import { cidrWithin, isPrivateCidr, isUsableHostIp } from "@/core/ip";
import { heldConfigs, validateAddressing, validateAll } from "@/core/validate";
import type { Snapshot } from "@/core/model";
import { client, lan, scenarios, site, snapshot } from "../fixtures/snapshots";

const held = (snap: Snapshot) => heldConfigs(snap, validateAll(snap, generateAll(snap)));
const sorted = (o: Record<string, string>) => Object.keys(o).sort();

describe("address classes", () => {
  it("knows private space only when a network lies wholly inside it", () => {
    for (const c of ["10.0.0.0/8", "10.20.0.0/16", "172.16.5.0/24", "172.31.255.0/24", "192.168.1.0/24", "100.64.0.0/10", "100.127.0.0/24"]) expect(isPrivateCidr(c), c).toBe(true);
    for (const c of ["8.8.8.0/24", "172.32.0.0/24", "192.169.0.0/24", "0.0.0.0/4", "10.0.0.0/7", "100.128.0.0/24", "nonsense"]) expect(isPrivateCidr(c), c).toBe(false);
    expect(cidrWithin("10.1.2.0/24", "10.1.0.0/16")).toBe(true);
    expect(cidrWithin("10.1.0.0/15", "10.1.0.0/16")).toBe(false);
  });

  it("refuses addresses no host on a LAN can hold", () => {
    for (const ip of ["10.0.250.2", "192.168.1.1", "203.0.113.5", "100.64.0.1", "223.255.255.254"]) expect(isUsableHostIp(ip), ip).toBe(true);
    for (const ip of ["0.0.0.0", "0.1.2.3", "127.0.0.1", "127.9.9.9", "169.254.10.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "300.1.1.1", "x"]) expect(isUsableHostIp(ip), ip).toBe(false);
  });
});

describe("shared networks in public space", () => {
  it("are a warning, not an error", () => {
    const snap = snapshot([site("a", { lans: [lan("8.8.8.0/24", "Oops"), lan("10.1.0.0/24", "LAN"), lan("203.0.113.0/24", "Own space, not shared", { shared: false })], tunnelIp: "10.99.0.1", lanIp: "10.1.0.2" })]);
    const f = validateAddressing(snap).filter((x) => x.code === "public-lan");
    expect(f).toHaveLength(1);
    expect(f[0]!.level).toBe("warning");
    expect(f[0]!.message).toContain("8.8.8.0/24");
    expect(sorted(held(snap).gateways)).toEqual([]);
  });
});

describe("held configs", () => {
  it("hold nothing when there is no error", () => {
    for (const name of ["two-sites", "hub-and-spoke", "two-spokes", "policies", "pending-site"]) {
      expect(held(scenarios[name]!()), name).toEqual({ gateways: {}, clients: {} });
    }
  });

  it("hold a site's addressing fault wherever that site is written", () => {
    const snap = scenarios["hub-and-spoke"]!();
    snap.sites.find((s) => s.slug === "warehouse")!.lans.push(lan("10.99.1.0/25", "Clashes with the client range"));
    const h = held(snap);
    // Every gateway reaches the warehouse, and both clients reach it through their relay.
    expect(sorted(h.gateways)).toEqual(["gw-dc", "gw-office", "gw-warehouse"]);
    expect(sorted(h.clients)).toEqual(["client-alice-laptop", "client-bob-phone"]);
    expect(h.gateways["gw-dc"]).toContain("overlaps the client range");
  });

  it("hold a client's fault only where that client is written", () => {
    const snap = scenarios["policies"]!();
    // The contractor may only use the office: only the office gateway carries it.
    snap.clients.find((c) => c.slug === "contractor")!.tunnelIp = "10.50.0.1";
    const h = held(snap);
    expect(sorted(h.gateways)).toEqual(["gw-office"]);
    expect(sorted(h.clients)).toEqual(["client-contractor"]);
  });

  it("hold only the client itself for a reference to a deleted site", () => {
    const snap = scenarios["two-sites"]!();
    snap.clients[0]!.allowedSiteIds = ["site-dc", "site-deleted"];
    expect(held(snap)).toEqual({ gateways: {}, clients: { "client-alice-laptop": 'Alice\'s laptop: allowed site "site-deleted" does not exist' } });
  });

  it("hold both sides of a clash between two sites, and nothing while one is not in the mesh", () => {
    const snap = scenarios["pending-site"]!();
    snap.sites[1]!.lans.push(lan("10.0.1.0/24", "Same as the datacentre"));
    expect(validateAll(snap, generateAll(snap)).some((f) => f.code === "overlap")).toBe(true);
    expect(held(snap)).toEqual({ gateways: {}, clients: {} });

    const three = snapshot(
      [
        site("a", { lans: [lan("10.1.0.0/16", "A")], tunnelIp: "10.99.0.1", lanIp: "10.1.0.2", hubPriority: 1 }),
        site("b", { lans: [lan("10.1.5.0/24", "B")], tunnelIp: "10.99.0.2", lanIp: "10.1.5.2", hubPriority: 2 }),
        site("c", { lans: [lan("10.3.0.0/24", "C")], tunnelIp: "10.99.0.3", lanIp: "10.3.0.2", hubPriority: 3 }),
      ],
      [client("x", "10.99.1.10", { allowedSiteIds: ["site-c"] })],
    );
    const h = held(three);
    // a and b are written into every gateway; the client only reaches c, which carries a and b but not in the client's config.
    expect(sorted(h.gateways)).toEqual(["gw-a", "gw-b", "gw-c"]);
    expect(sorted(h.clients)).toEqual([]);
  });

  it("hold one gateway for a fault in its own generated file", () => {
    const snap = scenarios["two-sites"]!();
    snap.sites[0]!.gateway!.mtu = 9000;
    const h = held(snap);
    expect(sorted(h.gateways)).toEqual(["gw-dc"]);
    expect(sorted(h.clients)).toEqual([]);
  });

  it("hold everything for a fault in the shared settings", () => {
    const snap = scenarios["hub-and-spoke"]!();
    snap.settings.mtu = 900;
    const h = held(snap);
    expect(sorted(h.gateways)).toEqual(["gw-dc", "gw-office", "gw-warehouse"]);
    expect(sorted(h.clients)).toEqual(["client-alice-laptop", "client-bob-phone"]);
  });

  it("hold nothing for sites that simply have no path to each other", () => {
    const snap = scenarios["no-hub"]!();
    expect(validateAll(snap, generateAll(snap)).map((f) => f.code)).toContain("unreachable-pair");
    expect(held(snap)).toEqual({ gateways: {}, clients: {} });
  });

  it("hold both owners of a shared key", () => {
    const snap = scenarios["two-spokes"]!();
    snap.clients[0]!.publicKey = snap.sites.find((s) => s.slug === "shop-north")!.gateway!.publicKey;
    const h = held(snap);
    // shop-north is reached by every site; the client enters at both hubs.
    expect(sorted(h.gateways)).toEqual(["gw-dc", "gw-office", "gw-shop-north", "gw-shop-south"]);
    expect(sorted(h.clients)).toEqual(["client-alice-laptop"]);
  });
});
