import QRCode from "qrcode";
import { consumeInvite, peekInvite } from "@/server/clients";
import { json, rateLimited, withPublic } from "@/server/http";
import { requestSource } from "@/server/auth";
import { renderClientConf } from "@/server/snapshot";

export const dynamic = "force-dynamic";

type P = { token: string };

const ERRORS = {
  invalid: "This link is not valid.",
  expired: "This link has expired. Ask your administrator for a new one.",
  used: "This link has already been used. Ask your administrator for a new one if you still need the configuration.",
} as const;

/** Look, without consuming: the page shows who the config is for. */
export const GET = withPublic<P>(async (req, { params }) => {
  if (rateLimited(`invite:${requestSource(req)}`, 60, 15 * 60_000)) return json({ error: "too many requests" }, 429);
  const r = peekInvite(params.token);
  if ("error" in r) return json({ error: ERRORS[r.error] }, 404);
  return json({ name: r.client.name, tunnelIp: r.client.tunnelIp });
});

/** Consume: returns the config and QR exactly once. */
export const POST = withPublic<P>(async (req, { params }) => {
  if (rateLimited(`invite:${requestSource(req)}`, 60, 15 * 60_000)) return json({ error: "too many requests" }, 429);
  const r = consumeInvite(params.token);
  if ("error" in r) return json({ error: ERRORS[r.error] }, 404);
  const conf = renderClientConf(r.client.id);
  if (!conf) return json({ error: "This device is not enabled or no site is reachable yet. Ask your administrator." }, 409);
  const qrSvg = await QRCode.toString(conf, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return json({ name: r.client.name, slug: r.client.slug, conf, qrSvg });
});
