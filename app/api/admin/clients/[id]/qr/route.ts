import QRCode from "qrcode";
import { firstInWindow, json, withAdmin } from "@/server/http";
import { getClient } from "@/server/clients";
import { logEvent } from "@/server/events";
import { clientConfHeld, renderClientConf } from "@/server/snapshot";

export const dynamic = "force-dynamic";

/** How often repeated views of one client's key by one session are written to the audit log. */
const AUDIT_EVERY_MS = 10 * 60_000;

/** The config as a QR code (SVG by default, ?format=png for an image file). */
export const GET = withAdmin<{ id: string }>(async (req, { params, admin }) => {
  const c = getClient(params.id);
  if (!c) return json({ error: "client not found" }, 404);
  const held = clientConfHeld(params.id);
  if (held) return json({ error: `configuration on hold until this is fixed: ${held}` }, 409);
  const conf = renderClientConf(params.id);
  if (!conf) return json({ error: "no config available for this client" }, 409);
  const format = new URL(req.url).searchParams.get("format") === "png" ? "png" : "svg";
  // The code carries the private key: say who took it.
  if (firstInWindow(`audit:qr:${admin.sessionId}:${c.id}:${format}`, AUDIT_EVERY_MS)) {
    logEvent("client", `QR code for "${c.name}" ${format === "png" ? "downloaded as an image" : "shown"} (includes the private key)`, { actor: admin.email, subject: c.id });
  }
  if (format === "png") {
    const png = await QRCode.toBuffer(conf, { type: "png", width: 512, margin: 2, errorCorrectionLevel: "M" });
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  }
  const svg = await QRCode.toString(conf, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" } });
});
