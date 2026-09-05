import { json, parseBody, withAdmin } from "@/server/http";
import { removeLan, updateLan } from "@/server/sites";
import { lanSchema } from "../route";

export const dynamic = "force-dynamic";

type P = { id: string; lanId: string };

export const PATCH = withAdmin<P>(async (req, { params, admin }) => {
  const body = await parseBody(req, lanSchema.partial());
  return json(updateLan(params.id, params.lanId, body, admin.email));
});

export const DELETE = withAdmin<P>(async (_req, { params, admin }) => {
  removeLan(params.id, params.lanId, admin.email);
  return json({ ok: true });
});
