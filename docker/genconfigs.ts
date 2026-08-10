/**
 * Simulation config generator: takes the reference fixture, swaps in freshly
 * generated real keypairs, runs the production generator, and writes each
 * node's files into docker/state/ for the compose mesh to mount.
 *
 * Also produces everything the phase-3 agent/control loop needs:
 *   - state/sites.yml            source of truth served by the control server
 *   - state/<site>/agent.json    agent configuration (poll URL, paths)
 *   - state/<site>/agent.token   per-node bearer token
 *   - state/control/tokens.json  token → node map for the control server
 *   - state/control/server.mjs   bundled control dev server (esbuild)
 *
 * SIMULATION ONLY: a real deployment generates keys on each node and they
 * never leave it; here the harness plays the role of every node at once.
 * docker/state/ is gitignored.
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { build } from "esbuild";
import { copyFileSync } from "node:fs";
import { sitesFileSchema, resolveConfig } from "../lib/schema.js";
import { generateAll } from "../lib/generator/index.js";
import { runValidators } from "../lib/validators/index.js";
import { CLIENT_PRIVATE_KEY_PLACEHOLDER } from "../lib/generator/wireguard.js";
import { emptyRegistry, hashToken } from "../lib/enrol/registry.js";
import { wgKeypair, agentToken } from "./simkeys.js";

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = join(here, "state");

const CONTROL_URL = "http://10.10.7.10:8080";
const AGENT_POLL_SEC = 3;

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
mkdirSync(join(stateDir, "control"), { recursive: true });

// Source of truth for the control server (public keys only, like the real thing).
writeFileSync(join(stateDir, "sites.yml"), stringifyYaml(raw), "utf8");

const registry = emptyRegistry();

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

  const token = agentToken();
  registry.bindings[siteId] = { nodeTokenHash: hashToken(token), role: "gateway" };
  writeFileSync(join(dir, "agent.token"), token + "\n", { encoding: "utf8", mode: 0o600 });
  writeFileSync(
    join(dir, "agent.json"),
    JSON.stringify(
      {
        server_url: CONTROL_URL,
        token_file: "/etc/opnmesh/agent.token",
        conf_dir: "/etc/opnmesh",
        state_dir: "/var/lib/opnmesh",
        wg_interface: "wg0",
        poll_interval_sec: AGENT_POLL_SEC,
        commit_confirm_sec: 20,
        boot_watchdog_sec: 45,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

writeFileSync(
  join(stateDir, "control", "registry.json"),
  JSON.stringify(registry, null, 2) + "\n",
  { encoding: "utf8", mode: 0o600 },
);
copyFileSync(join(here, "..", "deploy", "install.sh"), join(stateDir, "control", "install.sh"));

for (const [clientId, { config }] of Object.entries(bundle.clients)) {
  const dir = join(stateDir, "clients", clientId);
  mkdirSync(dir, { recursive: true });
  const withKey = config.replace(CLIENT_PRIVATE_KEY_PLACEHOLDER, keys.get(clientId)!.privateKey);
  writeFileSync(join(dir, "wg0.conf"), withKey, { encoding: "utf8", mode: 0o600 });
}

// Observability stack config for the sim: Prometheus + rules verbatim from
// deploy/, Alertmanager rendered with the sim's mailpit SMTP sink (real
// deployments substitute their own environment).
const obsDir = join(stateDir, "obs");
mkdirSync(join(obsDir, "prometheus", "rules"), { recursive: true });
copyFileSync(
  join(here, "..", "deploy", "prometheus", "prometheus.yml"),
  join(obsDir, "prometheus", "prometheus.yml"),
);
copyFileSync(
  join(here, "..", "deploy", "prometheus", "rules", "opnmesh.yml"),
  join(obsDir, "prometheus", "rules", "opnmesh.yml"),
);
mkdirSync(join(obsDir, "alertmanager"), { recursive: true });
const amTemplate = readFileSync(join(here, "..", "deploy", "alertmanager", "alertmanager.yml"), "utf8");
const amRendered = amTemplate
  .replace(/\$\{OPNMESH_SMTP_HOST\}/g, "mailpit")
  .replace(/\$\{OPNMESH_SMTP_PORT\}/g, "1025")
  .replace(/\$\{OPNMESH_SMTP_FROM\}/g, "opnmesh@example.test")
  .replace(/\$\{OPNMESH_ALERT_TO\}/g, "ops@example.test");
writeFileSync(join(obsDir, "alertmanager", "alertmanager.yml"), amRendered, "utf8");

// Bundle the control dev server so the control container only needs plain Node.
await build({
  entryPoints: [join(here, "..", "scripts", "control-dev.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: join(stateDir, "control", "server.mjs"),
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

console.log(
  `wrote simulation state for ${cfg.sites.length} gateways and ${cfg.clients.length} client(s) to ${stateDir}`,
);
