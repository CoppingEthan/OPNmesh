import { z } from "zod";
import { json, parseBody, withAdmin } from "@/server/http";
import { createInvite, INVITE_TTL_MS } from "@/server/clients";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";

const schema = z.object({ ttlHours: z.number().min(1).max(24 * 14).optional() });

/** A one-time link the person opens to collect their config themselves. */
export const POST = withAdmin<{ id: string }>(async (req, { params, admin }) => {
  const body = await parseBody(req, schema);
  const { token, expiresAt } = createInvite(params.id, body.ttlHours ? body.ttlHours * 3600_000 : INVITE_TTL_MS, admin.email);
  return json({ url: `${env().publicUrl}/invite/${token}`, expiresAt });
});
