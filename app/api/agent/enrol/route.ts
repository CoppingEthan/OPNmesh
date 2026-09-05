import { z } from "zod";
import { json, parseBody, rateLimited, withPublic } from "@/server/http";
import { enrolGateway } from "@/server/sites";
import { requestSource } from "@/server/auth";

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

/** Public, token-gated, rate-limited: a gateway joins the mesh. */
export const POST = withPublic(async (req) => {
  if (rateLimited(`enrol:${requestSource(req)}`, 20, 15 * 60_000)) return json({ error: "too many enrolment attempts" }, 429);
  const body = await parseBody(req, schema);
  const r = enrolGateway(body);
  if (!r.ok) {
    const messages = {
      "invalid-token": "enrolment token is not valid",
      expired: "enrolment token has expired — issue a new one in the UI",
      used: "enrolment token has already been used",
      "bad-key": "public key is malformed",
      "no-address": "no usable IPv4 address was reported",
    } as const;
    return json({ error: messages[r.reason], reason: r.reason }, r.reason === "bad-key" || r.reason === "no-address" ? 400 : 403);
  }
  return json({ gatewayId: r.gatewayId, gatewayToken: r.gatewayToken, status: r.status, siteName: r.siteName }, 201);
});
