/**
 * Every validator has a passing and a failing test (§16 phase 1).
 * Failing cases mutate the resolved config or tamper with generated output.
 */
import { describe, expect, it } from "vitest";
import { generateAll } from "../lib/generator/index.js";
import {
  runValidators,
  validateAddressing,
  validateAllowedIps,
  validateMtu,
  validateNoSnat,
  validatePorts,
  validateTopology,
  type Finding,
} from "../lib/validators/index.js";
import { FIXTURES, loadFixture, mutate } from "./helpers.js";

const codes = (f: Finding[]) => f.map((x) => x.code);
const errors = (f: Finding[]) => f.filter((x) => x.level === "error");

describe("all fixtures validate clean", () => {
  it.each(FIXTURES)("%s has no errors", (name) => {
    const cfg = loadFixture(name);
    expect(errors(runValidators(cfg, generateAll(cfg)))).toEqual([]);
  });

  it("reference has no warnings either", () => {
    const cfg = loadFixture("reference");
    expect(runValidators(cfg, generateAll(cfg))).toEqual([]);
  });
});

describe("addressing", () => {
  const cfg = loadFixture("reference");

  it("passes on the reference topology", () => {
    expect(validateAddressing(cfg)).toEqual([]);
  });

  it("rejects overlapping site LANs", () => {
    const bad = mutate(cfg, (c) => {
      c.sites[1]!.lans[0]!.cidr = "10.10.128.0/17";
      c.sites[1]!.advertised = ["10.10.128.0/17"];
    });
    expect(codes(validateAddressing(bad))).toContain("overlap");
  });

  it("rejects a LAN with host bits set", () => {
    const bad = mutate(cfg, (c) => (c.sites[0]!.lans[0]!.cidr = "10.10.0.2/16"));
    expect(codes(validateAddressing(bad))).toContain("lan-host-bits");
  });

  it("rejects a LAN overlapping tunnel space", () => {
    const bad = mutate(cfg, (c) => (c.sites[0]!.lans[0]!.cidr = "10.99.0.0/16"));
    expect(codes(validateAddressing(bad))).toContain("overlap");
  });

  it("rejects two VLANs at the same site overlapping each other", () => {
    const bad = mutate(cfg, (c) => {
      c.sites[0]!.lans.push({ cidr: "10.10.0.0/24", name: "Voice", vlan: 20, role: "standard" });
    });
    expect(codes(validateAddressing(bad))).toContain("overlap");
  });

  it("allows guest VLANs to overlap across sites — they are never routed", () => {
    const ok = mutate(cfg, (c) => {
      for (const s of c.sites.slice(0, 2)) {
        s.lans.push({ cidr: "192.168.1.0/24", name: "Guest", vlan: 90, role: "guest" });
      }
    });
    expect(codes(validateAddressing(ok))).not.toContain("overlap");
  });

  it("rejects a tunnel IP outside the gateway subnet", () => {
    const bad = mutate(cfg, (c) => (c.sites[0]!.gateway.tunnelIp = "10.99.9.1"));
    expect(codes(validateAddressing(bad))).toContain("tunnel-ip");
  });

  it("rejects a client IP outside the client subnet", () => {
    const bad = mutate(cfg, (c) => (c.clients[0]!.tunnelIp = "10.99.0.10"));
    expect(codes(validateAddressing(bad))).toContain("client-ip");
  });

  it("rejects a lan_ip outside its own LAN", () => {
    const bad = mutate(cfg, (c) => (c.sites[0]!.gateway.lanIp = "10.20.0.2"));
    expect(codes(validateAddressing(bad))).toContain("lan-ip");
  });

  it("rejects duplicate tunnel IPs and duplicate public keys", () => {
    const dupIp = mutate(cfg, (c) => (c.sites[1]!.gateway.tunnelIp = c.sites[0]!.gateway.tunnelIp));
    expect(codes(validateAddressing(dupIp))).toContain("dup-tunnel-ip");
    const dupKey = mutate(cfg, (c) => (c.clients[0]!.publicKey = c.sites[0]!.gateway.publicKey));
    expect(codes(validateAddressing(dupKey))).toContain("dup-key");
  });
});

describe("AllowedIPs", () => {
  const cfg = loadFixture("reference");

  it("passes on generated output", () => {
    expect(validateAllowedIps(cfg, generateAll(cfg))).toEqual([]);
  });

  it("rejects a default route", () => {
    const bundle = generateAll(cfg);
    const conf = bundle.nodes["site-a"]!.files["wg0.conf"]!;
    bundle.nodes["site-a"]!.files["wg0.conf"] = conf.replace(
      "AllowedIPs = 10.99.0.2/32, 10.20.0.0/16",
      "AllowedIPs = 0.0.0.0/0",
    );
    const findings = validateAllowedIps(cfg, bundle);
    expect(codes(findings)).toContain("default-route");
  });

  it("rejects a subnet listed against the wrong peer — routing bug and security hole at once", () => {
    const bundle = generateAll(cfg);
    const conf = bundle.nodes["site-a"]!.files["wg0.conf"]!;
    // Move site-c's LAN onto site-b's peer entry.
    bundle.nodes["site-a"]!.files["wg0.conf"] = conf.replace(
      "AllowedIPs = 10.99.0.2/32, 10.20.0.0/16",
      "AllowedIPs = 10.99.0.2/32, 10.20.0.0/16, 10.30.0.0/16",
    );
    expect(codes(validateAllowedIps(cfg, bundle))).toContain("allowedips-mismatch");
  });

  it("rejects a client peer granted more than its /32", () => {
    const bundle = generateAll(cfg);
    const conf = bundle.nodes["site-a"]!.files["wg0.conf"]!;
    bundle.nodes["site-a"]!.files["wg0.conf"] = conf.replace(
      "AllowedIPs = 10.99.1.10/32",
      "AllowedIPs = 10.99.1.10/32, 10.20.0.0/16",
    );
    expect(codes(validateAllowedIps(cfg, bundle))).toContain("allowedips-mismatch");
  });

  it("rejects the same prefix on two client peers", () => {
    const bundle = generateAll(cfg);
    const conf = bundle.clients["laptop"]!.config;
    // Duplicate site-b's LAN onto the site-a peer as well.
    bundle.clients["laptop"]!.config = conf.replace(
      "AllowedIPs = 10.99.0.1/32, 10.10.0.0/16",
      "AllowedIPs = 10.99.0.1/32, 10.10.0.0/16, 10.20.0.0/16",
    );
    expect(codes(validateAllowedIps(cfg, bundle))).toContain("duplicate-prefix");
  });
});

describe("no SNAT", () => {
  const cfg = loadFixture("reference");

  it("passes on generated output", () => {
    expect(validateNoSnat(generateAll(cfg))).toEqual([]);
  });

  it("fails when a masquerade rule sneaks in", () => {
    const bundle = generateAll(cfg);
    bundle.nodes["site-a"]!.files["nftables.conf"] += '\n    oifname "wg0" masquerade\n';
    expect(codes(validateNoSnat(bundle))).toContain("snat");
  });

  it("fails on snat rules too", () => {
    const bundle = generateAll(cfg);
    bundle.nodes["site-b"]!.files["nftables.conf"] += "\n    snat to 10.20.0.2\n";
    expect(codes(validateNoSnat(bundle))).toContain("snat");
  });
});

describe("MTU", () => {
  const cfg = loadFixture("reference");

  it("passes at defaults", () => {
    expect(validateMtu(cfg)).toEqual([]);
  });

  it("errors outside 1280–1500 and warns above 1420", () => {
    const low = mutate(cfg, (c) => (c.sites[0]!.gateway.mtu = 1200));
    expect(codes(validateMtu(low))).toContain("mtu-range");
    const high = mutate(cfg, (c) => (c.clients[0]!.mtu = 1460));
    const findings = validateMtu(high);
    expect(codes(findings)).toContain("mtu-high");
    expect(findings[0]!.level).toBe("warning");
  });
});

describe("ports", () => {
  const cfg = loadFixture("reference");

  it("passes on the reference topology", () => {
    expect(validatePorts(cfg)).toEqual([]);
  });

  it("warns on privileged ports", () => {
    const findings = validatePorts(loadFixture("custom-ports"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("privileged-port");
    expect(findings[0]!.level).toBe("warning");
  });

  it("errors when two gateways publish the same host:port", () => {
    const bad = mutate(cfg, (c) => {
      c.sites[1]!.gateway.endpoint = c.sites[0]!.gateway.endpoint;
    });
    expect(codes(validatePorts(bad))).toContain("port-collision");
  });

  it("errors when metrics and WireGuard share a port on one node", () => {
    const bad = mutate(cfg, (c) => (c.sites[0]!.gateway.metricsPort = c.sites[0]!.gateway.listenPort));
    expect(codes(validatePorts(bad))).toContain("port-collision");
  });

  it("allows the same host on different ports", () => {
    const ok = mutate(cfg, (c) => {
      c.sites[1]!.gateway.endpoint = c.sites[0]!.gateway.endpoint;
      c.sites[1]!.gateway.listenPort = 51821;
    });
    expect(validatePorts(ok)).toEqual([]);
  });
});

describe("topology / SPOF", () => {
  it("passes clean on the full mesh", () => {
    expect(validateTopology(loadFixture("reference"))).toEqual([]);
  });

  it("errors on an unreachable pair (two NAT sites in a full mesh)", () => {
    const bad = mutate(loadFixture("reference"), (c) => {
      c.sites[1]!.gateway.endpoint = null;
      c.sites[2]!.gateway.endpoint = null;
    });
    const findings = validateTopology(bad);
    expect(codes(findings)).toContain("unreachable-pair");
    expect(errors(findings).length).toBeGreaterThan(0);
  });

  it("warns loudly that a single hub is a SPOF", () => {
    const findings = validateTopology(loadFixture("single-hub"));
    expect(codes(findings)).toContain("spof");
    expect(findings.find((f) => f.code === "spof")!.message).toMatch(/single point of failure/);
  });

  it("warns which pairs a hub's death would sever", () => {
    const findings = validateTopology(loadFixture("multi-hub"));
    const spof = findings.find((f) => f.code === "spof");
    expect(spof).toBeDefined();
    expect(spof!.message).toContain("site-c ↔ site-d");
  });

  it("warns when a client has a single entry point", () => {
    const findings = validateTopology(loadFixture("single-hub"));
    expect(codes(findings)).toContain("client-single-entry");
  });
});
