/**
 * IPv4 / CIDR utilities. v1 is IPv4-only; the schema rejects IPv6 so nothing
 * downstream needs to handle it.
 */

export interface Cidr {
  /** Network address as a 32-bit unsigned int (host bits zeroed). */
  network: number;
  prefix: number;
}

export function isValidIpv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}

export function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function isValidCidr(s: string): boolean {
  const m = s.split("/");
  if (m.length !== 2) return false;
  const [ip, prefix] = m;
  if (!isValidIpv4(ip!)) return false;
  if (!/^([0-9]|[12][0-9]|3[0-2])$/.test(prefix!)) return false;
  return true;
}

/** Parse "a.b.c.d/p". Throws on invalid input; validate first at the boundary. */
export function parseCidr(s: string): Cidr {
  if (!isValidCidr(s)) throw new Error(`invalid CIDR: ${s}`);
  const [ip, prefixStr] = s.split("/");
  const prefix = Number(prefixStr);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (ipToInt(ip!) & mask) >>> 0, prefix };
}

/** True if the address part of "a.b.c.d/p" has host bits set (e.g. 10.10.0.5/16). */
export function cidrHasHostBits(s: string): boolean {
  const [ip] = s.split("/");
  return ipToInt(ip!) !== parseCidr(s).network;
}

export function cidrToString(c: Cidr): string {
  return `${intToIp(c.network)}/${c.prefix}`;
}

function lastAddress(c: Cidr): number {
  const size = c.prefix === 32 ? 1 : 2 ** (32 - c.prefix);
  return (c.network + size - 1) >>> 0;
}

export function cidrOverlaps(a: string, b: string): boolean {
  const ca = parseCidr(a);
  const cb = parseCidr(b);
  return ca.network <= lastAddress(cb) && cb.network <= lastAddress(ca);
}

/** True if `inner` (CIDR or bare IP) lies entirely within `outer`. */
export function cidrContains(outer: string, inner: string): boolean {
  const co = parseCidr(outer);
  const ci = parseCidr(inner.includes("/") ? inner : `${inner}/32`);
  return ci.network >= co.network && lastAddress(ci) <= lastAddress(co) && ci.prefix >= co.prefix;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  return cidrContains(cidr, `${ip}/32`);
}

/** True if `s` is a hostname rather than an IPv4 literal. */
export function isHostname(s: string): boolean {
  return !isValidIpv4(s) && /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(s);
}

/** Sort key for deterministic peer ordering. */
export function compareIp(a: string, b: string): number {
  return ipToInt(a) - ipToInt(b);
}
