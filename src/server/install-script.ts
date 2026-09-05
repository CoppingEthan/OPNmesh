/**
 * The gateway installer, served at /install.sh with the controller URL baked
 * in. The script itself lives in deploy/gateway/install.sh so it can be read,
 * linted and tested as a file; this module only substitutes the URL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export function installScript(publicUrl: string): string {
  return template().replace(/__OPNMESH_URL__/g, publicUrl);
}
