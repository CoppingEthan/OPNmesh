import { json, text, withAdmin } from "@/server/http";
import { getClient } from "@/server/clients";
import { renderClientConf } from "@/server/snapshot";

export const dynamic = "force-dynamic";

/** The complete WireGuard config, private key included, as a downloadable file. */
export const GET = withAdmin<{ id: string }>(async (req, { params }) => {
  const c = getClient(params.id);
  if (!c) return json({ error: "client not found" }, 404);
  const conf = renderClientConf(params.id);
  if (!conf) return json({ error: c.enabled ? "no reachable site yet — add an endpoint to a gateway first" : "client is disabled" }, 409);
  const download = new URL(req.url).searchParams.get("download") === "1";
  const filename = `${c.slug.slice(0, 15)}.conf`; // WireGuard limits interface names to 15 chars
  return text(conf, 200, download ? { "Content-Disposition": `attachment; filename="${filename}"` } : {});
});
