import QRCode from "qrcode";
import { json, withAdmin } from "@/server/http";
import { getClient } from "@/server/clients";
import { renderClientConf } from "@/server/snapshot";

export const dynamic = "force-dynamic";

/** The config as a QR code (SVG by default, ?format=png for an image file). */
export const GET = withAdmin<{ id: string }>(async (req, { params }) => {
  const c = getClient(params.id);
  if (!c) return json({ error: "client not found" }, 404);
  const conf = renderClientConf(params.id);
  if (!conf) return json({ error: "no config available for this client" }, 409);
  const format = new URL(req.url).searchParams.get("format");
  if (format === "png") {
    const png = await QRCode.toBuffer(conf, { type: "png", width: 512, margin: 2, errorCorrectionLevel: "M" });
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  }
  const svg = await QRCode.toString(conf, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" } });
});
