import { json, parseBody, withAdmin } from "@/server/http";
import { deleteClient, getClient, updateClient } from "@/server/clients";
import { clientSchema } from "../route";

export const dynamic = "force-dynamic";

type P = { id: string };

function publicView<T extends { privateKeyEnc: string; pskEnc: string | null }>(c: T) {
  const { privateKeyEnc: _p, pskEnc: _k, ...rest } = c;
  return rest;
}

export const GET = withAdmin<P>(async (_req, { params }) => {
  const c = getClient(params.id);
  return c ? json(publicView(c)) : json({ error: "client not found" }, 404);
});

export const PATCH = withAdmin<P>(async (req, { params, admin }) => {
  const body = await parseBody(req, clientSchema.partial());
  return json(publicView(updateClient(params.id, body, admin.email)));
});

export const DELETE = withAdmin<P>(async (_req, { params, admin }) => {
  deleteClient(params.id, admin.email);
  return json({ ok: true });
});
