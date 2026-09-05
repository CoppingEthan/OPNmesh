import { readFileSync } from "node:fs";
import { json } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Public: the private CA certificate gateways pin when the controller has no
 * public hostname. Served only when OPNMESH_CA_FILE points at Caddy's root
 * certificate; installers verify its fingerprint before trusting it.
 */
export async function GET(): Promise<Response> {
  const file = process.env["OPNMESH_CA_FILE"];
  if (!file) return json({ error: "this controller uses a public certificate; no private CA to download" }, 404);
  try {
    const pem = readFileSync(file, "utf8");
    return new Response(pem, { headers: { "Content-Type": "application/x-pem-file", "Cache-Control": "no-cache" } });
  } catch {
    return json({ error: "CA certificate not available yet" }, 503);
  }
}
