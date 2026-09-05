/**
 * Keys, tokens and sealing. Node's crypto only — no third-party primitives.
 *
 * WireGuard keys are X25519: 32 random bytes (clamped) and the derived public
 * point, both base64. Node exposes X25519 directly, so key generation here is
 * exactly what `wg genkey | wg pubkey` produces.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface KeyPair {
  privateKey: string;
  publicKey: string;
}

const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

function b64urlToB64(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return b + "=".repeat((4 - (b.length % 4)) % 4);
}

/** Generate a WireGuard keypair. */
export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const priv = privateKey.export({ format: "jwk" }) as { d?: string };
  const pub = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!priv.d || !pub.x) throw new Error("x25519 export failed");
  return { privateKey: b64urlToB64(priv.d), publicKey: b64urlToB64(pub.x) };
}

/** Derive the public key for a base64 WireGuard private key. */
export function publicKeyFromPrivate(privateKeyB64: string): string {
  const raw = Buffer.from(privateKeyB64, "base64");
  if (raw.length !== 32) throw new Error("private key must be 32 bytes");
  const der = Buffer.concat([PKCS8_X25519_PREFIX, raw]);
  const priv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv).export({ format: "jwk" }) as { x?: string };
  if (!pub.x) throw new Error("x25519 public export failed");
  return b64urlToB64(pub.x);
}

/** WireGuard pre-shared key: 32 random bytes, base64. */
export function generatePresharedKey(): string {
  return randomBytes(32).toString("base64");
}

/** Opaque bearer/enrolment token: 32 random bytes, base64url (43 chars). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function randomId(bytes = 8): string {
  return randomBytes(bytes).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
}

export function sha256Hex(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Short fingerprint for a public key, shown for out-of-band verification. */
export function keyFingerprint(publicKey: string): string {
  return sha256Hex(publicKey).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Sealing secrets at rest: AES-256-GCM with a key derived from the server
// secret via HKDF. Output is "v1." + base64url(nonce ‖ ciphertext ‖ tag).

function sealingKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), "opnmesh", purpose, 32));
}

export function seal(plaintext: string, secret: string, purpose = "secret"): string {
  const key = sealingKey(secret, purpose);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "v1." + Buffer.concat([nonce, ct, tag]).toString("base64url");
}

export function open(sealed: string, secret: string, purpose = "secret"): string {
  if (!sealed.startsWith("v1.")) throw new Error("unknown sealed format");
  const buf = Buffer.from(sealed.slice(3), "base64url");
  if (buf.length < 12 + 16) throw new Error("sealed value too short");
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", sealingKey(secret, purpose), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
