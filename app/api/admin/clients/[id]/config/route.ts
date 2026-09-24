import { firstInWindow, json, text, withAdmin } from "@/server/http";
import { getClient } from "@/server/clients";
import { logEvent } from "@/server/events";
import { clientConfHeld, renderClientConf } from "@/server/snapshot";

export const dynamic = "force-dynamic";

/** How often repeated views of one client's key by one session are written to the audit log. */
const AUDIT_EVERY_MS = 10 * 60_000;

/** The complete WireGuard config, private key included, as a downloadable file. */
export const GET = withAdmin<{ id: string }>(async (req, { params, admin }) => {
  const c = getClient(params.id);
  if (!c) return json({ error: "client not found" }, 404);
  const held = clientConfHeld(params.id);
  if (held) return json({ error: `configuration on hold until this is fixed: ${held}` }, 409);
  const conf = renderClientConf(params.id);
  if (!conf) return json({ error: c.enabled ? "no reachable site yet — add an endpoint to a gateway first" : "client is disabled" }, 409);
  const download = new URL(req.url).searchParams.get("download") === "1";
  // The response carries the private key: say who took it.
  if (firstInWindow(`audit:config:${admin.sessionId}:${c.id}:${download ? "file" : "text"}`, AUDIT_EVERY_MS)) {
    logEvent("client", `Configuration for "${c.name}" ${download ? "downloaded" : "shown as text"} (includes the private key)`, { actor: admin.email, subject: c.id });
  }
  const filename = `${c.slug.slice(0, 15)}.conf`; // WireGuard limits interface names to 15 chars
  return text(conf, 200, download ? { "Content-Disposition": `attachment; filename="${filename}"` } : {});
});
