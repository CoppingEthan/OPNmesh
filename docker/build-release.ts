/**
 * Build + sign an agent release for the simulation, entirely inside Docker
 * (no host Go or minisign needed):
 *   1. go build with the version (and optional broken-build test hook)
 *      stamped via ldflags
 *   2. minisign keypair on first use — public key distributed to every
 *      node's /etc/opnmesh (mounted state dir), secret key stays in
 *      state/control/minisign/
 *   3. detached .minisig signature + sha256
 *   4. register the release with the control server
 *
 * Usage: tsx docker/build-release.ts --version 2.0.0 [--broken] [--config-digest <hex>|current]
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const stateDir = join(here, "state");
const CONTROL = process.env["OPNMESH_CONTROL_URL"] ?? "http://localhost:18080";

const args = process.argv.slice(2);
const getArg = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const version = getArg("--version");
const broken = args.includes("--broken");
const configDigest = getArg("--config-digest");
if (!version) {
  console.error("usage: tsx docker/build-release.ts --version <v> [--broken] [--config-digest <hex>]");
  process.exit(2);
}

const sh = (cmd: string): string => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const dockerPath = (p: string): string => p.replace(/\\/g, "/");

const releaseDir = join(stateDir, "control", "releases", version);
mkdirSync(releaseDir, { recursive: true });
const keyDir = join(stateDir, "control", "minisign");
mkdirSync(keyDir, { recursive: true });

console.log(`building agent ${version}${broken ? " (deliberately broken test build)" : ""}...`);
sh(
  `docker run --rm -v "${dockerPath(join(repo, "agent"))}:/src:ro" -v "${dockerPath(releaseDir)}:/out" golang:1.23-alpine ` +
    `sh -c "cp -r /src /build && cd /build && go build -ldflags '-X main.version=${version}${broken ? " -X main.simulateBroken=yes" : ""}' -o /out/opnmesh-agent ."`,
);

if (!existsSync(join(keyDir, "key.sec"))) {
  console.log("generating minisign keypair (first release)...");
  sh(
    `docker run --rm -v "${dockerPath(keyDir)}:/keys" alpine:3.20 ` +
      `sh -c "apk add --no-cache -q minisign && minisign -G -W -f -p /keys/key.pub -s /keys/key.sec"`,
  );
}
// Distribute the public key to every node dir (mounted as /etc/opnmesh).
for (const entry of readdirSync(stateDir)) {
  if (entry.startsWith("site-")) {
    copyFileSync(join(keyDir, "key.pub"), join(stateDir, entry, "minisign.pub"));
  }
}

console.log("signing...");
sh(
  `docker run --rm -v "${dockerPath(keyDir)}:/keys" -v "${dockerPath(releaseDir)}:/out" alpine:3.20 ` +
    `sh -c "apk add --no-cache -q minisign && minisign -S -s /keys/key.sec -m /out/opnmesh-agent"`,
);

const sha256 = createHash("sha256").update(readFileSync(join(releaseDir, "opnmesh-agent"))).digest("hex");

const register = async () => {
  const res = await fetch(`${CONTROL}/api/v1/admin/releases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version, sha256, configDigest: configDigest ?? null }),
  });
  if (!res.ok) throw new Error(`release registration failed: ${res.status} ${await res.text()}`);
  console.log(`registered release ${version} (sha256 ${sha256.slice(0, 12)}…)`);
};
await register();
