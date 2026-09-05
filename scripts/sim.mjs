#!/usr/bin/env node
/**
 * Drive the simulation.
 *   node scripts/sim.mjs up      build the agent + images, start everything
 *   node scripts/sim.mjs down    stop and remove containers, volumes and state
 *   node scripts/sim.mjs logs    follow logs
 *   node scripts/sim.mjs ps
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const cmd = process.argv[2] ?? "up";
const compose = ["compose", "-f", "sim/docker-compose.yml"];

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { stdio: "inherit", ...opts });
  if (r.status !== 0 && !opts.allowFail) process.exit(r.status ?? 1);
  return r.status;
}

switch (cmd) {
  case "up": {
    if (!existsSync(resolve("agent/bin/opnmesh-gw-linux-amd64"))) run("node", ["scripts/agent-build.mjs"]);
    for (const d of ["gw-a", "gw-b", "gw-c", "gw-d", "client", "controller"]) mkdirSync(resolve("sim/state", d), { recursive: true });
    // Build the two images explicitly: the shared node image is referenced by
    // many services and must be built once, not once per service.
    run("docker", [...compose, "--profile", "build", "build", "node-image", "controller"]);
    run("docker", [...compose, "up", "-d", "--remove-orphans"]);
    console.log("\nsimulation is up. Controller API: http://127.0.0.1:18080  — run: npm run sim:test");
    break;
  }
  case "down":
    run("docker", [...compose, "down", "-v", "--remove-orphans"], { allowFail: true });
    rmSync(resolve("sim/state"), { recursive: true, force: true });
    break;
  case "logs":
    run("docker", [...compose, "logs", "-f", "--tail", "50", ...process.argv.slice(3)]);
    break;
  case "ps":
    run("docker", [...compose, "ps"]);
    break;
  default:
    console.error("usage: sim.mjs up|down|logs|ps");
    process.exit(2);
}
