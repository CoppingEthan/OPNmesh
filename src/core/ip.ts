/**
 * IPv4 and CIDR arithmetic. Pure functions, no dependencies.
 *
 * Addresses are handled as unsigned 32-bit numbers internally; every function
 * that takes a string validates it and returns null (or false) on bad input
 * rather than throwing, so callers at trust boundaries can report problems.
 */

export function parseIpv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

export function formatIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function isValidIpv4(s: string): boolean {
  return parseIpv4(s) !== null;
}

export interface Cidr {
  /** The address as written (may have host bits set). */
  address: number;
  prefix: number;
  network: number;
  broadcast: number;
}

export function parseCidr(s: string): Cidr | null {
  const parts = s.split("/");
  if (parts.length !== 2) return null;
  const [ip, p] = parts as [string, string];
  if (!/^\d{1,2}$/.test(p)) return null;
  const address = parseIpv4(ip);
  const prefix = Number(p);
  if (address === null || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (address & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { address, prefix, network, broadcast };
}

export function isValidCidr(s: string): boolean {
  return parseCidr(s) !== null;
}

/** "10.0.1.7/24" → "10.0.1.0/24". Returns null for invalid input. */
export function normalizeCidr(s: string): string | null {
  const c = parseCidr(s);
  return c ? `${formatIpv4(c.network)}/${c.prefix}` : null;
}

export function cidrHasHostBits(s: string): boolean {
  const c = parseCidr(s);
  return c !== null && c.address !== c.network;
}

export function cidrContainsIp(cidr: string, ip: string): boolean {
  const c = parseCidr(cidr);
  const n = parseIpv4(ip);
  if (c === null || n === null) return false;
  return n >= c.network && n <= c.broadcast;
}

export function cidrOverlaps(a: string, b: string): boolean {
  const ca = parseCidr(a);
  const cb = parseCidr(b);
  if (ca === null || cb === null) return false;
  return ca.network <= cb.broadcast && cb.network <= ca.broadcast;
}

/** Number of addresses usable for hosts (excludes network and broadcast for /30 and larger). */
export function usableHostCount(cidr: string): number {
  const c = parseCidr(cidr);
  if (c === null) return 0;
  if (c.prefix >= 31) return 2 ** (32 - c.prefix);
  return c.broadcast - c.network - 1;
}

/** Sort helper: numeric order of dotted addresses (with or without a /prefix). */
export function compareIp(a: string, b: string): number {
  const na = parseIpv4(a.split("/")[0] ?? "") ?? 0;
  const nb = parseIpv4(b.split("/")[0] ?? "") ?? 0;
  return na - nb;
}

/**
 * First host address in `cidr` not present in `used`. The network address and
 * the first host (conventionally the router) are skipped unless `skip` says
 * otherwise; the broadcast address is never returned.
 */
export function nextFreeIp(cidr: string, used: Iterable<string>, skip = 1): string | null {
  const c = parseCidr(cidr);
  if (c === null) return null;
  const taken = new Set<number>();
  for (const u of used) {
    const n = parseIpv4(u.split("/")[0] ?? "");
    if (n !== null) taken.add(n);
  }
  const first = c.prefix >= 31 ? c.network : c.network + 1 + skip;
  const last = c.prefix >= 31 ? c.broadcast : c.broadcast - 1;
  for (let n = first; n <= last; n++) {
    if (!taken.has(n)) return formatIpv4(n);
  }
  return null;
}

/** RFC 1123 hostname (used for DDNS endpoints). */
export function isHostname(s: string): boolean {
  if (s.length === 0 || s.length > 253 || isValidIpv4(s)) return false;
  return s
    .split(".")
    .every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

/** Private or otherwise non-routable ranges that a LAN is allowed to be in. */
export function isPrivateCidr(cidr: string): boolean {
  return (
    cidrOverlaps(cidr, "10.0.0.0/8") ||
    cidrOverlaps(cidr, "172.16.0.0/12") ||
    cidrOverlaps(cidr, "192.168.0.0/16") ||
    cidrOverlaps(cidr, "100.64.0.0/10")
  );
}
