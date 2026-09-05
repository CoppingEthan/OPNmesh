import { describe, expect, it } from "vitest";
import { generateAll } from "@/core/generate";
import { validateAddressing, validateAll, validateAllowedIps, validateNat, validateTopology } from "@/core/validate";
import { client, lan, scenarios, site, snapshot } from "../fixtures/snapshots";

const codes = (f: Array<{ code: string }>) => f.map((x) => x.code);

describe("addressing", () => {
  it("rejects overlapping shared LANs across sites", () => {
    const snap = snapshot([
      site("a", { lans: [lan("192.168.1.0/24", "LAN")], tunnelIp: "10.99.0.1", lanIp: "192.168.1.2", layout: "same_lan" }),
      site("b", { lans: [lan("192.168.1.0/24", "LAN")], tunnelIp: "10.99.0.2", lanIp: "192.168.1.2", layout: "same_lan" }),
    ]);
    expect(codes(validateAddressing(snap))).toContain("overlap");
  });
  it("allows overlapping unshared LANs", () => {
    const snap = snapshot([
      site("a", { lans: [lan("10.1.0.0/24", "A"), lan("192.168.1.0/24", "Guest", { shared: false })], tunnelIp: "10.99.0.1", lanIp: "10.1.0.2" }),
      site("b", { lans: [lan("10.2.0.0/24", "B"), lan("192.168.1.0/24", "Guest", { shared: false })], tunnelIp: "10.99.0.2", lanIp: "10.2.0.2" }),
    ]);
    expect(codes(validateAddressing(snap))).not.toContain("overlap");
  });
  it("rejects host bits, tunnel range overlaps, duplicate addresses and keys", () => {
    const base = scenarios["two-sites"]!();
    base.sites[0]!.lans.push(lan("10.99.0.0/24", "Oops"));
    base.sites[1]!.lans.push(lan("10.5.5.5/24", "Bad"));
    base.clients.push(client("dup", "10.99.1.10"));
    const c = codes(validateAddressing(base));
    expect(c).toContain("overlap");
    expect(c).toContain("host-bits");
    expect(c).toContain("dup-ip");
  });
  it("warns about layout / address mismatches", () => {
    const snap = snapshot([
      site("a", { lans: [lan("10.1.0.0/24", "A")], tunnelIp: "10.99.0.1", lanIp: "10.1.0.2", layout: "transit" }),
      site("b", { lans: [lan("10.2.0.0/24", "B")], tunnelIp: "10.99.0.2", lanIp: "10.9.0.2", layout: "same_lan" }),
    ]);
    const f = validateAddressing(snap);
    expect(f.filter((x) => x.code === "lan-ip").map((x) => x.subject?.id)).toEqual(["site-a", "site-b"]);
    expect(f.every((x) => x.level === "warning")).toBe(true);
  });
  it("rejects two gateways publishing the same endpoint and port", () => {
    const snap = snapshot([
      site("a", { lans: [lan("10.1.0.0/24", "A")], tunnelIp: "10.99.0.1", lanIp: "10.1.0.2", endpoint: "vpn.example.com" }),
      site("b", { lans: [lan("10.2.0.0/24", "B")], tunnelIp: "10.99.0.2", lanIp: "10.2.0.2", endpoint: "vpn.example.com" }),
    ]);
    expect(codes(validateAddressing(snap))).toContain("port-collision");
    snap.sites[1]!.gateway!.listenPort = 51821;
    expect(codes(validateAddressing(snap))).not.toContain("port-collision");
  });
});

describe("generated-output checks", () => {
  it("catch a tampered AllowedIPs", () => {
    const snap = scenarios["two-sites"]!();
    const bundle = generateAll(snap);
    const g = bundle.gateways["gw-dc"]!;
    g.files["wireguard.conf"] = g.files["wireguard.conf"].replace("192.168.30.0/24", "192.168.30.0/24, 0.0.0.0/0");
    const c = codes(validateAllowedIps(snap, bundle));
    expect(c).toContain("default-route");
    expect(c).toContain("allowedips-mismatch");
  });
  it("catch a near-default supernet", () => {
    const snap = scenarios["two-sites"]!();
    const bundle = generateAll(snap);
    const g = bundle.gateways["gw-dc"]!;
    g.files["wireguard.conf"] = g.files["wireguard.conf"].replace("192.168.30.0/24", "128.0.0.0/1");
    expect(codes(validateAllowedIps(snap, bundle))).toContain("default-route");
  });
  it("catch NAT on a non-masquerade site", () => {
    const snap = scenarios["two-sites"]!();
    const bundle = generateAll(snap);
    bundle.gateways["gw-dc"]!.files["nftables.conf"] += "\n# extra\ntable ip nat { chain post { type nat hook postrouting priority srcnat; oifname eth0 masquerade } }\n";
    expect(codes(validateNat(snap, bundle))).toEqual(["nat"]);
  });
});

describe("topology findings", () => {
  it("flags unreachable pairs and single hubs", () => {
    expect(codes(validateTopology(scenarios["no-hub"]!()))).toEqual(["unreachable-pair"]);
    const hub = scenarios["hub-and-spoke"]!();
    hub.sites[1]!.gateway!.endpointHost = null; // office loses its port: dc becomes the only hub
    expect(codes(validateTopology(hub))).toContain("single-hub");
  });
  it("explains what a hub's death severs", () => {
    const f = validateTopology(scenarios["two-spokes"]!());
    expect(f.find((x) => x.code === "spof")?.message).toContain("Shop North ↔ Shop South");
  });
  it("warns when a client has nowhere to go", () => {
    const snap = scenarios["two-sites"]!();
    snap.clients[0]!.allowedSiteIds = ["site-nonexistent"];
    const all = validateAll(snap, generateAll(snap));
    expect(codes(all)).toContain("bad-ref");
    expect(codes(all)).toContain("client-no-entry");
  });
});
