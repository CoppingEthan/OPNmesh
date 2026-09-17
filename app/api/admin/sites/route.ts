import { z } from "zod";
import { json, parseBody, withAdmin } from "@/server/http";
import { createSite, listSites, publicSite } from "@/server/sites";

export const dynamic = "force-dynamic";

export const GET = withAdmin(async () => json(listSites().map(publicSite)));

export const siteSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().max(31).optional(),
  notes: z.string().max(2000).optional(),
  routerLayout: z.enum(["transit", "same_lan", "masquerade"]).optional(),
  hubPriority: z.number().int().optional(),
  dnsServer: z.string().max(64).nullable().optional(),
  dnsDomain: z.string().max(253).nullable().optional(),
  alertEmail: z.boolean().optional(),
});

export const POST = withAdmin(async (req, { admin }) => {
  const body = await parseBody(req, siteSchema);
  return json(publicSite(createSite(body, admin.email)), 201);
});
