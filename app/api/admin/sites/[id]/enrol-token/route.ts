import { z } from "zod";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** SHA-256 of the private CA root file Caddy issued, when the controller uses one. */
function privateCaFingerprint(): string | null {
  const file = process.env["OPNMESH_CA_FILE"];
  if (!file) return null;
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}
import { json, parseBody, withAdmin } from "@/server/http";
import { createEnrolToken, getSite } from "@/server/sites";
import { publicUrl } from "@/server/settings";
import { installScript } from "@/server/install-script";

export const dynamic = "force-dynamic";

const schema = z.object({ autoApprove: z.boolean().optional() });

/** Issue a one-time enrolment token and the install one-liner that carries it. */
export const POST = withAdmin<{ id: string }>(async (req, { params, admin }) => {
  const site = getSite(params.id);
  if (!site) return json({ error: "site not found" }, 404);
  const body = await parseBody(req, schema);
  const { token, expiresAt } = createEnrolToken(params.id, { autoApprove: body.autoApprove ?? true }, admin.email);
  const base = publicUrl();
  const script = installScript(base);
  const sha256 = createHash("sha256").update(script).digest("hex");
  const insecure = base.startsWith("http://") ? " --insecure-http" : "";
  // Private CA (no public hostname): the command carries the CA fingerprint
  // so the installer verifies what it downloads before trusting it.
  const caFingerprint = privateCaFingerprint();
  const ca = caFingerprint ? ` --ca-fingerprint ${caFingerprint}` : "";
  return json({
    token,
    expiresAt,
    command: `curl -fsSL ${base}/install.sh | sudo bash -s -- --token ${token}${ca}${insecure}`,
    installScriptSha256: sha256,
    caFingerprint,
    replaces: site.gateway ? site.gateway.hostname || site.gateway.name : null,
  });
});
