/** x25519 keypair generation, byte-compatible with WireGuard. Sim/test only. */
import { generateKeyPairSync, randomBytes } from "node:crypto";

export function wgKeypair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  // Raw keys are the last 32 bytes of the DER encodings.
  const pub = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  const priv = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32);
  return { publicKey: pub.toString("base64"), privateKey: priv.toString("base64") };
}

export function agentToken(): string {
  return randomBytes(32).toString("hex");
}
