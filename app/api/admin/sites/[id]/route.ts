import { json, parseBody, withAdmin } from "@/server/http";
import { deleteSite, getSite, updateSite } from "@/server/sites";
import { siteSchema } from "../route";

export const dynamic = "force-dynamic";

type P = { id: string };

export const GET = withAdmin<P>(async (_req, { params }) => {
  const site = getSite(params.id);
  return site ? json(site) : json({ error: "site not found" }, 404);
});

export const PATCH = withAdmin<P>(async (req, { params, admin }) => {
  const body = await parseBody(req, siteSchema.partial());
  return json(updateSite(params.id, body, admin.email));
});

export const DELETE = withAdmin<P>(async (_req, { params, admin }) => {
  deleteSite(params.id, admin.email);
  return json({ ok: true });
});
