/**
 * The gateway installer, served at /install.sh with the controller URL baked
 * in, and the one-line commands that run it. The script itself lives in
 * deploy/gateway/install.sh so it can be read, linted and tested as a file;
 * this module substitutes the URL and builds the commands.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicUrl } from "./settings";

let cached: string | null = null;

function template(): string {
  if (cached) return cached;
  const candidates = [join(process.cwd(), "deploy", "gateway", "install.sh"), join(process.cwd(), "install.sh")];
  for (const p of candidates) {
    try {
      cached = readFileSync(p, "utf8");
      return cached;
    } catch {
      /* try next */
    }
  }
  throw new Error("deploy/gateway/install.sh not found");
}

export function installScript(url: string): string {
  return template().replace(/__OPNMESH_URL__/g, url);
}

/** SHA-256 of the private CA root file Caddy issued, when the controller uses one. */
export function privateCaFingerprint(): string | null {
  const file = process.env["OPNMESH_CA_FILE"];
  if (!file) return null;
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

export interface GatewayCommand {
  command: string;
  installScriptSha256: string;
  caFingerprint: string | null;
}

/**
 * The command an admin pastes into a gateway VM: enrolment with a one-time
 * token, or an in-place agent upgrade.
 *
 * With a public certificate the familiar `curl … | sudo bash` is enough: the
 * download is verified by TLS. With the private CA it is not, because the VM
 * does not trust that CA yet, so the command fetches the installer without
 * verification, checks it against the SHA-256 the admin is looking at, and
 * only then runs it; the installer pins the CA by fingerprint for everything
 * after that.
 */
export function gatewayCommand(opts: { token: string } | { upgrade: true }): GatewayCommand {
  const base = publicUrl();
  const installScriptSha256 = createHash("sha256").update(installScript(base)).digest("hex");
  const caFingerprint = base.startsWith("https://") ? privateCaFingerprint() : null;
  const flags = [
    "token" in opts ? `--token ${opts.token}` : "--upgrade",
    caFingerprint ? `--ca-fingerprint ${caFingerprint}` : null,
    base.startsWith("http://") ? "--insecure-http" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const command = caFingerprint
    ? `f=$(mktemp) && curl -fsSLk ${base}/install.sh -o "$f" && echo "${installScriptSha256}  $f" | sha256sum -c --quiet && sudo bash "$f" ${flags}`
    : `curl -fsSL ${base}/install.sh | sudo bash -s -- ${flags}`;
  return { command, installScriptSha256, caFingerprint };
}
