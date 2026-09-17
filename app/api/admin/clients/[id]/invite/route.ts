import { z } from "zod";
import { json, parseBody, withAdmin } from "@/server/http";
import { createInvite, getClient, INVITE_TTL_MS, pendingInvite, revokeInvites } from "@/server/clients";
import { publicUrl } from "@/server/settings";

export const dynamic = "force-dynamic";

const schema = z.object({ ttlHours: z.number().min(1).max(24 * 14).optional() });

type P = { id: string };

/** Whether a link sent earlier can still be collected. The link itself cannot be shown again. */
export const GET = withAdmin<P>(async (_req, { params }) => {
  if (!getClient(params.id)) return json({ error: "client not found" }, 404);
  return json({ pending: pendingInvite(params.id) });
});

/** A one-time link the person opens to collect their config themselves. Replaces any unused one. */
export const POST = withAdmin<P>(async (req, { params, admin }) => {
  const body = await parseBody(req, schema);
  const { token, expiresAt } = createInvite(params.id, body.ttlHours ? body.ttlHours * 3600_000 : INVITE_TTL_MS, admin.email);
  return json({ url: `${publicUrl()}/invite/${token}`, expiresAt });
});

/** Cancel the client's unused link. */
export const DELETE = withAdmin<P>(async (_req, { params, admin }) => {
  const revoked = revokeInvites(params.id, admin.email);
  return json({ ok: true, revoked });
});
