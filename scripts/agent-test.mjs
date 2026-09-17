#!/usr/bin/env node
/**
 * go vet + go test for the agent, inside the official Go image. The whole
 * checkout is mounted because the agent's tests read test/golden/.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const extra = process.argv.slice(2).join(" ");
const r = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${resolve(".")}:/repo`,
    "-v",
    "opnmesh-v2-gomod:/go/pkg/mod",
    "-w",
    "/repo/agent",
    "-e",
    "GOFLAGS=-mod=mod",
    "golang:1.27",
    "sh",
    "-c",
    `go mod tidy && test -z "$(gofmt -l .)" || { echo 'gofmt: files need formatting:'; gofmt -l .; exit 1; }; go vet ./... && go test ./... ${extra}`,
  ],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
