/**
 * The gateway installer, served at /install.sh with the controller URL baked
 * in, and the one-line commands that run it. The script itself lives in
 * deploy/gateway/install.sh so it can be read, linted and tested as a file;
 * this module substitutes the URL and builds the commands.
 */
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env";
import { isSafeOrigin, publicUrl } from "./settings";

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

/**
 * The URL goes into shell commands that gateways run as root, so it must be a
 * plain origin; Settings refuses anything else, and so does this, for a bad
 * OPNMESH_PUBLIC_URL. Plain http needs the explicit lab switch.
 */
function checkedBase(url: string): string {
  if (!isSafeOrigin(url)) throw new Error(`public URL ${JSON.stringify(url)} is not a plain http(s) origin; fix OPNMESH_PUBLIC_URL or Settings → Public URL`);
  if (url.startsWith("http://") && !env().insecureHttp) throw new Error("public URL uses http:// but OPNMESH_INSECURE_HTTP is not set");
  return url;
}

export function installScript(url: string): string {
  const base = checkedBase(url);
  return template().replace(/__OPNMESH_URL__/g, () => base);
}

/**
 * SHA-256 fingerprint of the private CA root Caddy issued, when the
 * controller uses one: lowercase hex over the certificate's DER encoding, the
 * same value browsers and `openssl x509 -fingerprint -sha256` show (there
 * with colons), so an admin can check it against the certificate itself.
 */
export function privateCaFingerprint(): string | null {
  const file = process.env["OPNMESH_CA_FILE"];
  if (!file) return null;
  try {
    return new X509Certificate(readFileSync(file)).fingerprint256.replace(/:/g, "").toLowerCase();
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
 *
 * The enrolment token never appears in a command line, since `ps` shows every
 * process's arguments to every user and sudo logs its own. The shell's
 * built-in printf (no process of its own) writes it to a file only this user
 * can read (mktemp creates it 0600), the installer reads it with
 * --token-file, and the file is removed when the command ends, however it
 * ends. The subshell keeps the variable and the trap out of the admin's shell.
 */
export function gatewayCommand(opts: { token: string } | { upgrade: true }): GatewayCommand {
  const base = checkedBase(publicUrl());
  const installScriptSha256 = createHash("sha256").update(installScript(base)).digest("hex");
  const caFingerprint = base.startsWith("https://") ? privateCaFingerprint() : null;
  // Tokens are base64url; anything else could break out of the quotes below.
  if ("token" in opts && !/^[A-Za-z0-9_-]+$/.test(opts.token)) throw new Error("enrolment token has an unexpected format");
  const flags = [
    "token" in opts ? `--token-file "$t"` : "--upgrade",
    caFingerprint ? `--ca-fingerprint ${caFingerprint}` : null,
    base.startsWith("http://") ? "--insecure-http" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const install = caFingerprint
    ? `f=$(mktemp) && curl -fsSLk ${base}/install.sh -o "$f" && echo "${installScriptSha256}  $f" | sha256sum -c --quiet && sudo bash "$f" ${flags}`
    : `curl -fsSL ${base}/install.sh | sudo bash -s -- ${flags}`;
  const command =
    "token" in opts ? `(t=$(mktemp) && trap 'rm -f "$t"' EXIT && printf '%s\\n' '${opts.token}' > "$t" && ${install})` : install;
  return { command, installScriptSha256, caFingerprint };
}
