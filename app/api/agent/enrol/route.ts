import { z } from "zod";
import { json, rateLimited, withPublic } from "@/server/http";
import { enrolGateway, enrolTokenUsable } from "@/server/sites";
import { requestSource } from "@/server/auth";
import { sha256Hex } from "@/core/crypto";
import { ENROL_MAX_BODY, parseAgentBody } from "../_lib/body";

export const dynamic = "force-dynamic";

const schema = z.object({
  token: z.string().min(20).max(128),
  publicKey: z.string().min(40).max(48),
  hostname: z.string().max(253).default(""),
  os: z.string().max(120).default(""),
  arch: z.string().max(32).default(""),
  addresses: z.array(z.string().max(64)).max(32).default([]),
  agentVersion: z.string().max(32).default(""),
});

const WINDOW_MS = 15 * 60_000;
/** Attempts that could never succeed (no usable token, or no valid request) from one source. */
const MAX_FUTILE_PER_SOURCE = 20;
/** Attempts with one usable token: it is spent by the first that succeeds. */
const MAX_PER_TOKEN = 10;

const tooMany = () => json({ error: "too many enrolment attempts" }, 429);

/**
 * Public, token-gated, rate-limited: a gateway joins the mesh.
 *
 * Only attempts that cannot succeed count against where they came from.
 * Without a configured proxy every caller is the same source, so counting
 * every request there would let anyone who sends junk here lock out real
 * gateways; those hold a usable token, and their attempts count against
 * that token instead.
 */
export const POST = withPublic(async (req) => {
  const source = `enrol:${requestSource(req)}`;
  let body: z.infer<typeof schema>;
  try {
    body = await parseAgentBody(req, schema, ENROL_MAX_BODY);
  } catch (e) {
    if (rateLimited(source, MAX_FUTILE_PER_SOURCE, WINDOW_MS)) return tooMany();
    throw e;
  }
  const limited = enrolTokenUsable(body.token)
    ? rateLimited(`enrol-token:${sha256Hex(body.token)}`, MAX_PER_TOKEN, WINDOW_MS)
    : rateLimited(source, MAX_FUTILE_PER_SOURCE, WINDOW_MS);
  if (limited) return tooMany();
  const r = enrolGateway(body);
  if (!r.ok) {
    const answers = {
      "invalid-token": ["enrolment token is not valid", 403],
      expired: ["enrolment token has expired — issue a new one in the UI", 403],
      used: ["enrolment token has already been used", 403],
      "bad-key": ["public key is malformed", 400],
      "duplicate-key": ["this public key already belongs to another gateway or client — remove that gateway, or delete /etc/opnmesh/private.key here so a new key is made", 409],
      "no-address": ["no usable IPv4 address was reported (loopback, link-local, multicast and reserved addresses do not count)", 400],
      "gateway-active": ["this site already has an active gateway, and this token needs approval, so it cannot replace it — remove the site's gateway in the OPNmesh UI first, or use a token that approves automatically", 409],
    } as const satisfies Record<typeof r.reason, readonly [string, number]>;
    const [error, status] = answers[r.reason];
    return json({ error, reason: r.reason }, status);
  }
  return json({ gatewayId: r.gatewayId, gatewayToken: r.gatewayToken, status: r.status, siteName: r.siteName }, 201);
});
