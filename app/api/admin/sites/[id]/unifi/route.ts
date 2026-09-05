import { z } from "zod";
import { json, parseBody, withAdmin } from "@/server/http";
import { getLink, linkView, saveLink, unlink, UnifiLinkError } from "@/server/unifi";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

type P = { id: string };

export const authSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("api_key"), apiKey: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("password"), username: z.string().min(1).max(120), password: z.string().min(1).max(500) }),
]);

const saveSchema = z.object({
  baseUrl: z.string().min(1).max(300),
  unifiSite: z.string().max(64).default("default"),
  auth: authSchema,
  standalone: z.boolean().optional(),
  certFingerprint: z.string().max(128).nullable().default(null),
  certPem: z.string().max(20_000).nullable().default(null),
});

export const GET = withAdmin<P>(async (_req, { params }) => {
  const row = getLink(params.id);
  return json(row ? linkView(row) : null);
});

export const PUT = withAdmin<P>(async (req, { params, admin }) => {
  try {
    const body = await parseBody(req, saveSchema);
    const row = saveLink(params.id, body, admin.email);
    return json(linkView(row));
  } catch (e) {
    if (e instanceof UnifiLinkError) return json({ error: e.message }, e.status);
    return errorResponse(e);
  }
});

export const DELETE = withAdmin<P>(async (req, { params, admin }) => {
  try {
    const remove = new URL(req.url).searchParams.get("remove") === "1";
    return json(await unlink(params.id, remove, admin.email));
  } catch (e) {
    if (e instanceof UnifiLinkError) return json({ error: e.message }, e.status);
    return errorResponse(e);
  }
});
