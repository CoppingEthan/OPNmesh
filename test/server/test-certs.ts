/**
 * Throwaway X.509 certificates for TLS tests, built at run time so no key
 * material is ever committed. A minimal DER writer is enough: EC P-256 keys,
 * ECDSA-SHA256 signatures, and the extensions Node's verifier looks at.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

export interface TestCert {
  /** PEM, for a server's `key` option. */
  key: string;
  cert: string;
  fingerprint: string;
}

export interface TestCa extends TestCert {
  name: string;
  privateKey: KeyObject;
}

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...c: Buffer[]) => tlv(0x30, ...c);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a! + b!];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
}

const name = (cn: string) => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn, "utf8")))));
const utcTime = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

function build(opts: { subject: string; issuer: string; publicKey: KeyObject; signer: KeyObject; ca: boolean; san: string[] }): string {
  const serial = randomBytes(8);
  serial[0] = (serial[0]! & 0x7f) | 0x40; // positive, minimal
  const spki = opts.publicKey.export({ type: "spki", format: "der" });
  const exts = [ext("2.5.29.19", true, opts.ca ? seq(tlv(0x01, Buffer.from([0xff]))) : seq()), ext("2.5.29.14", false, tlv(0x04, createHash("sha1").update(spki).digest()))];
  // keyCertSign + cRLSign for a CA, digitalSignature for a CA-issued server
  // certificate. A self-signed one gets none: OpenSSL only treats a
  // certificate as self-signed when its key usage allows signing certificates.
  if (opts.ca) exts.push(ext("2.5.29.15", true, tlv(0x03, Buffer.from([0x01, 0x06]))));
  else if (opts.issuer !== opts.subject) exts.push(ext("2.5.29.15", true, tlv(0x03, Buffer.from([0x07, 0x80]))));
  if (!opts.ca) {
    exts.push(ext("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))));
    const names = opts.san.map((h) => (isIP(h) ? tlv(0x87, Buffer.from(h.split(".").map(Number))) : tlv(0x82, Buffer.from(h))));
    exts.push(ext("2.5.29.17", false, seq(...names)));
  }
  // The real clock, which OpenSSL checks, even when a test has mocked Date.now.
  const now = new Date().getTime();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ECDSA_SHA256,
    name(opts.issuer),
    seq(utcTime(new Date(now - 365 * 86_400_000)), utcTime(new Date(now + 3650 * 86_400_000))),
    name(opts.subject),
    spki,
    tlv(0xa3, seq(...exts)),
  );
  const signature = sign("sha256", tbs, opts.signer);
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").trim()}\n-----END CERTIFICATE-----\n`;
}

function finish(cert: string, privateKey: KeyObject): TestCert {
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert, fingerprint: new X509Certificate(cert).fingerprint256.toLowerCase() };
}

/** A root CA, standing in for a public one. */
export function makeCa(cn = "OPNmesh Test Root"): TestCa {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { ...finish(build({ subject: cn, issuer: cn, publicKey, signer: privateKey, ca: true, san: [] }), privateKey), name: cn, privateKey };
}

/** A server certificate for `san` (host names and IPv4 addresses), signed by `ca` or self-signed like a console's. */
export function makeServerCert(san: string[], ca?: TestCa): TestCert {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const subject = san[0] ?? "unifi";
  return finish(build({ subject, issuer: ca ? ca.name : subject, publicKey, signer: ca ? ca.privateKey : privateKey, ca: false, san }), privateKey);
}
