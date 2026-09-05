#!/usr/bin/env node
/**
 * Build the Go agent for linux/amd64 and linux/arm64 inside the official Go
 * image (no local Go toolchain needed) into agent/bin/, with SHA-256 files
 * next to each binary. The controller serves them from /dl/.
 *
 *   node scripts/agent-build.mjs [version]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2] ?? JSON.parse(readFileSync("package.json", "utf8")).version;
const repo = resolve(".");
mkdirSync(resolve(repo, "agent", "bin"), { recursive: true });

const script = [
  "set -e",
  "cd /src",
  "go mod download",
  ...["amd64", "arm64"].map(
    (arch) =>
      `CGO_ENABLED=0 GOOS=linux GOARCH=${arch} go build -trimpath -ldflags '-s -w -X main.version=${version}' -o /out/opnmesh-gw-linux-${arch} .`,
  ),
  "cd /out && sha256sum opnmesh-gw-linux-amd64 > opnmesh-gw-linux-amd64.sha256 && sha256sum opnmesh-gw-linux-arm64 > opnmesh-gw-linux-arm64.sha256",
  "ls -la /out",
].join(" && ");

const r = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${resolve(repo, "agent")}:/src`,
    "-v",
    `${resolve(repo, "agent", "bin")}:/out`,
    "-v",
    "opnmesh-v2-gomod:/go/pkg/mod",
    "-e",
    "GOFLAGS=-mod=mod",
    "golang:1.24",
    "sh",
    "-c",
    script,
  ],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
