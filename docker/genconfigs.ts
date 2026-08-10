/**
 * Simulation config generator: takes the reference fixture, swaps in freshly
 * generated real keypairs, runs the production generator, and writes each
 * node's files into docker/state/ for the compose mesh to mount.
 *
 * Keys are x25519 via Node's crypto — byte-compatible with WireGuard.
 * SIMULATION ONLY: a real deployment generates keys on each node and they
 * never leave it; here the harness plays the role of every node at once.
 * docker/state/ is gitignored.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { sitesFileSchema, resolveConfig } from "../lib/schema.js";
import { generateAll } from "../lib/generator/index.js";
import { runValidators } from "../lib/validators/index.js";
import { CLIENT_PRIVATE_KEY_PLACEHOLDER } from "../lib/generator/wireguard.js";

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = join(here, "state");

function wgKeypair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  // Raw keys are the last 32 bytes of the DER encodings.
  const pub = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  const priv = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32);
  return { publicKey: pub.toString("base64"), privateKey: priv.toString("base64") };
}

const fixture = readFileSync(join(here, "..", "test", "fixtures", "reference.yml"), "utf8");
const raw = sitesFileSchema.parse(parseYaml(fixture));

const keys = new Map<string, { privateKey: string; publicKey: string }>();
for (const site of raw.sites) {
  const kp = wgKeypair();
  keys.set(site.id, kp);
  site.gateway.public_key = kp.publicKey;
}
for (const client of raw.clients) {
  const kp = wgKeypair();
  keys.set(client.id, kp);
  client.public_key = kp.publicKey;
}

const cfg = resolveConfig(raw);
const bundle = generateAll(cfg);

const findings = runValidators(cfg, bundle);
const errors = findings.filter((f) => f.level === "error");
if (errors.length > 0) {
  console.error("validation errors:", errors);
  process.exit(1);
}

rmSync(stateDir, { recursive: true, force: true });

for (const [siteId, node] of Object.entries(bundle.nodes)) {
  const dir = join(stateDir, siteId);
  mkdirSync(join(dir, "keys"), { recursive: true });
  for (const [name, content] of Object.entries(node.files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  writeFileSync(join(dir, "meta.json"), JSON.stringify(node.meta, null, 2) + "\n", "utf8");
  writeFileSync(join(dir, "keys", "wg0.key"), keys.get(siteId)!.privateKey + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

for (const [clientId, { config }] of Object.entries(bundle.clients)) {
  const dir = join(stateDir, "clients", clientId);
  mkdirSync(dir, { recursive: true });
  const withKey = config.replace(CLIENT_PRIVATE_KEY_PLACEHOLDER, keys.get(clientId)!.privateKey);
  writeFileSync(join(dir, "wg0.conf"), withKey, { encoding: "utf8", mode: 0o600 });
}

console.log(
  `wrote simulation state for ${cfg.sites.length} gateways and ${cfg.clients.length} client(s) to ${stateDir}`,
);
