import { z } from "zod";
import { json, parseBody, withAdmin } from "@/server/http";
import { createClient, listClients } from "@/server/clients";

export const dynamic = "force-dynamic";

export const clientSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().max(31).optional(),
  owner: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
  expiresAt: z.number().int().nullable().optional(),
  preferredSiteId: z.string().max(32).nullable().optional(),
  allowedSiteIds: z.array(z.string().max(32)).max(200).nullable().optional(),
  allowInbound: z.boolean().optional(),
});

function publicView<T extends { privateKeyEnc: string; pskEnc: string | null }>(c: T) {
  const { privateKeyEnc: _p, pskEnc: _k, ...rest } = c;
  return rest;
}

export const GET = withAdmin(async () => json(listClients().map(publicView)));

export const POST = withAdmin(async (req, { admin }) => {
  const body = await parseBody(req, clientSchema);
  return json(publicView(createClient(body, admin.email)), 201);
});
