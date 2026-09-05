import { json, withAdmin } from "@/server/http";
import { rotateClientKeys } from "@/server/clients";

export const dynamic = "force-dynamic";

export const POST = withAdmin<{ id: string }>(async (_req, { params, admin }) => {
  const c = rotateClientKeys(params.id, admin.email);
  return json({ ok: true, publicKey: c.publicKey });
});
