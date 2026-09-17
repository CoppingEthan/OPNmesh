import QRCode from "qrcode";
import { consumeInvite, peekInvite } from "@/server/clients";
import { json, rateLimited, withPublic } from "@/server/http";
import { requestSource } from "@/server/auth";
import { clientConfHeld, renderClientConf } from "@/server/snapshot";

export const dynamic = "force-dynamic";

type P = { token: string };

const ERRORS = {
  invalid: "This link is not valid.",
  expired: "This link has expired. Ask your administrator for a new one.",
  used: "This link has already been used. Ask your administrator for a new one if you still need the configuration.",
} as const;

const NOT_READY = "Your configuration cannot be handed out yet, so this link has not been used up. Ask your administrator, then try the link again.";

/** Look, without consuming: the page shows who the config is for. */
export const GET = withPublic<P>(async (req, { params }) => {
  if (rateLimited(`invite:${requestSource(req)}`, 60, 15 * 60_000)) return json({ error: "too many requests" }, 429);
  const r = peekInvite(params.token);
  if ("error" in r) return json({ error: ERRORS[r.error] }, 404);
  return json({ name: r.client.name, tunnelIp: r.client.tunnelIp });
});

/**
 * Consume: returns the config and QR exactly once. Everything is built
 * before the link is spent, so a config that cannot be handed out leaves the
 * link working. Rotating or disabling the client deletes the link, so if it
 * can still be spent afterwards, the config built here is still the client's.
 */
export const POST = withPublic<P>(async (req, { params }) => {
  if (rateLimited(`invite:${requestSource(req)}`, 60, 15 * 60_000)) return json({ error: "too many requests" }, 429);
  const r = peekInvite(params.token);
  if ("error" in r) return json({ error: ERRORS[r.error] }, 404);
  const conf = clientConfHeld(r.client.id) === null ? renderClientConf(r.client.id) : null;
  if (!conf) return json({ error: NOT_READY }, 409);
  const qrSvg = await QRCode.toString(conf, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  const spent = consumeInvite(params.token);
  if ("error" in spent) return json({ error: ERRORS[spent.error] }, 404);
  return json({ name: r.client.name, slug: r.client.slug, conf, qrSvg });
});
