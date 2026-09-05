import { describe, expect, it } from "vitest";
import {
  cidrContainsIp,
  cidrHasHostBits,
  cidrOverlaps,
  compareIp,
  formatIpv4,
  isHostname,
  isValidCidr,
  isValidIpv4,
  nextFreeIp,
  normalizeCidr,
  parseCidr,
  parseIpv4,
  usableHostCount,
} from "@/core/ip";

describe("ipv4", () => {
  it("parses and formats", () => {
    expect(parseIpv4("10.0.1.7")).toBe((10 << 24 | 0 << 16 | 1 << 8 | 7) >>> 0);
    expect(formatIpv4(parseIpv4("255.255.255.255")!)).toBe("255.255.255.255");
    expect(formatIpv4(parseIpv4("0.0.0.0")!)).toBe("0.0.0.0");
  });
  it("rejects junk", () => {
    for (const bad of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "a.b.c.d", " 1.2.3.4", "1.2.3.4/24"]) {
      expect(isValidIpv4(bad), bad).toBe(false);
    }
  });
});

describe("cidr", () => {
  it("computes network and broadcast", () => {
    const c = parseCidr("10.0.1.7/24")!;
    expect(formatIpv4(c.network)).toBe("10.0.1.0");
    expect(formatIpv4(c.broadcast)).toBe("10.0.1.255");
    expect(normalizeCidr("10.0.1.7/24")).toBe("10.0.1.0/24");
    expect(cidrHasHostBits("10.0.1.7/24")).toBe(true);
    expect(cidrHasHostBits("10.0.1.0/24")).toBe(false);
  });
  it("handles /0, /31 and /32", () => {
    expect(parseCidr("0.0.0.0/0")!.broadcast).toBe(0xffffffff);
    expect(usableHostCount("10.0.0.0/31")).toBe(2);
    expect(usableHostCount("10.0.0.1/32")).toBe(1);
    expect(usableHostCount("10.0.0.0/24")).toBe(254);
  });
  it("rejects junk", () => {
    for (const bad of ["10.0.0.0", "10.0.0.0/33", "10.0.0.0/-1", "10.0.0/24", "10.0.0.0/2x"]) {
      expect(isValidCidr(bad), bad).toBe(false);
    }
  });
  it("contains and overlaps", () => {
    expect(cidrContainsIp("192.168.20.0/24", "192.168.20.15")).toBe(true);
    expect(cidrContainsIp("192.168.20.0/24", "192.168.21.15")).toBe(false);
    expect(cidrOverlaps("10.0.0.0/8", "10.30.0.0/24")).toBe(true);
    expect(cidrOverlaps("10.0.1.0/24", "10.0.2.0/24")).toBe(false);
    expect(cidrOverlaps("192.168.1.0/24", "192.168.1.128/25")).toBe(true);
  });
  it("sorts numerically", () => {
    expect(["10.0.0.10", "10.0.0.9", "9.255.255.255"].sort(compareIp)).toEqual(["9.255.255.255", "10.0.0.9", "10.0.0.10"]);
  });
  it("finds the next free address", () => {
    expect(nextFreeIp("10.99.1.0/24", [])).toBe("10.99.1.2");
    expect(nextFreeIp("10.99.1.0/24", ["10.99.1.2", "10.99.1.3/32"])).toBe("10.99.1.4");
    expect(nextFreeIp("10.99.1.0/24", [], 0)).toBe("10.99.1.1");
    const full = Array.from({ length: 254 }, (_, i) => `10.99.1.${i + 1}`);
    expect(nextFreeIp("10.99.1.0/24", full)).toBeNull();
  });
});

describe("hostname", () => {
  it("accepts DDNS names and rejects addresses", () => {
    expect(isHostname("dc.example.com")).toBe(true);
    expect(isHostname("office-1.dyndns.org")).toBe(true);
    expect(isHostname("203.0.113.20")).toBe(false);
    expect(isHostname("-bad.example")).toBe(false);
    expect(isHostname("has space.example")).toBe(false);
  });
});
