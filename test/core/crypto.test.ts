import { describe, expect, it } from "vitest";
import { WG_KEY_RE } from "@/core/model";
import { digestsEqual, generateKeyPair, generatePresharedKey, keyFingerprint, open, publicKeyFromPrivate, randomToken, seal, sha256Hex } from "@/core/crypto";

describe("wireguard keys", () => {
  it("generates 44-char base64 keys whose public half derives from the private half", () => {
    const kp = generateKeyPair();
    expect(kp.privateKey).toMatch(WG_KEY_RE);
    expect(kp.publicKey).toMatch(WG_KEY_RE);
    expect(publicKeyFromPrivate(kp.privateKey)).toBe(kp.publicKey);
  });
  it("matches a known test vector", () => {
    // RFC 7748 §6.1: Alice's private and public keys.
    const priv = Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex").toString("base64");
    const pub = Buffer.from("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "hex").toString("base64");
    expect(publicKeyFromPrivate(priv)).toBe(pub);
  });
  it("makes distinct keys and PSKs", () => {
    expect(generateKeyPair().privateKey).not.toBe(generateKeyPair().privateKey);
    expect(generatePresharedKey()).toMatch(WG_KEY_RE);
  });
});

describe("tokens and digests", () => {
  it("random tokens are base64url and unique", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });
  it("compares digests in constant time and length-safely", () => {
    const a = sha256Hex("x");
    expect(digestsEqual(a, sha256Hex("x"))).toBe(true);
    expect(digestsEqual(a, sha256Hex("y"))).toBe(false);
    expect(digestsEqual(a, a.slice(1))).toBe(false);
  });
  it("fingerprints are short and stable", () => {
    expect(keyFingerprint("abc")).toHaveLength(16);
    expect(keyFingerprint("abc")).toBe(keyFingerprint("abc"));
  });
});

describe("sealing", () => {
  it("round-trips and binds to the secret and purpose", () => {
    const sealed = seal("wg-private-key", "server-secret", "client-key");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(open(sealed, "server-secret", "client-key")).toBe("wg-private-key");
    expect(() => open(sealed, "other-secret", "client-key")).toThrow();
    expect(() => open(sealed, "server-secret", "unifi")).toThrow();
    expect(seal("x", "s")).not.toBe(seal("x", "s")); // fresh nonce each time
  });
  it("rejects tampering", () => {
    const sealed = seal("hello", "s");
    const body = Buffer.from(sealed.slice(3), "base64url");
    body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 1;
    expect(() => open("v1." + body.toString("base64url"), "s")).toThrow();
  });
});
