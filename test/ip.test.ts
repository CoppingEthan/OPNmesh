import { describe, expect, it } from "vitest";
import {
  cidrContains,
  cidrHasHostBits,
  cidrOverlaps,
  ipInCidr,
  isHostname,
  isValidCidr,
  isValidIpv4,
  parseCidr,
  cidrToString,
} from "../lib/ip.js";

describe("ipv4 parsing", () => {
  it("accepts valid addresses and rejects junk", () => {
    expect(isValidIpv4("10.0.0.1")).toBe(true);
    expect(isValidIpv4("255.255.255.255")).toBe(true);
    expect(isValidIpv4("256.0.0.1")).toBe(false);
    expect(isValidIpv4("10.0.0")).toBe(false);
    expect(isValidIpv4("10.0.0.01")).toBe(false);
    expect(isValidIpv4("fe80::1")).toBe(false);
  });

  it("validates CIDRs", () => {
    expect(isValidCidr("10.0.0.0/8")).toBe(true);
    expect(isValidCidr("10.0.0.0/33")).toBe(false);
    expect(isValidCidr("10.0.0.0")).toBe(false);
  });

  it("normalizes networks", () => {
    expect(cidrToString(parseCidr("10.10.5.7/16"))).toBe("10.10.0.0/16");
    expect(cidrHasHostBits("10.10.5.7/16")).toBe(true);
    expect(cidrHasHostBits("10.10.0.0/16")).toBe(false);
  });
});

describe("overlap and containment", () => {
  it("detects overlaps", () => {
    expect(cidrOverlaps("10.10.0.0/16", "10.10.128.0/17")).toBe(true);
    expect(cidrOverlaps("10.10.0.0/16", "10.20.0.0/16")).toBe(false);
    expect(cidrOverlaps("10.99.0.0/24", "10.99.1.0/24")).toBe(false);
    expect(cidrOverlaps("0.0.0.0/0", "192.168.1.0/24")).toBe(true);
  });

  it("containment", () => {
    expect(cidrContains("10.99.0.0/24", "10.99.0.7/32")).toBe(true);
    expect(cidrContains("10.99.0.0/24", "10.99.1.7/32")).toBe(false);
    expect(ipInCidr("10.10.0.2", "10.10.0.0/16")).toBe(true);
    expect(ipInCidr("10.20.0.2", "10.10.0.0/16")).toBe(false);
  });
});

describe("hostnames", () => {
  it("distinguishes hostnames from IPs", () => {
    expect(isHostname("vpn-b.example.net")).toBe(true);
    expect(isHostname("198.51.100.10")).toBe(false);
    expect(isHostname("-bad.example")).toBe(false);
  });
});
