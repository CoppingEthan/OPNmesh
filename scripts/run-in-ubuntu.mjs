#!/usr/bin/env node
/**
 * Run an npm command inside a Node 22 Linux container with the repository
 * mounted, so tests execute on Linux even when developing on Windows/macOS.
 * node_modules is a named Docker volume: native modules (better-sqlite3,
 * argon2) built for the host must not be reused inside the container.
 *
 *   node scripts/run-in-ubuntu.mjs npm test
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cmd = process.argv.slice(2);
if (cmd.length === 0) {
  console.error("usage: run-in-ubuntu.mjs <command...>");
  process.exit(2);
}
const repo = resolve(".");
const args = [
  "run",
  "--rm",
  "-t",
  "-v",
  `${repo}:/w`,
  "-v",
  "opnmesh-v2-node-modules:/w/node_modules",
  "-w",
  "/w",
  "-e",
  "CI=1",
  "node:22-bookworm",
  "bash",
  "-lc",
  `npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund; ${cmd.join(" ")}`,
];
const r = spawnSync("docker", args, { stdio: "inherit" });
process.exit(r.status ?? 1);
