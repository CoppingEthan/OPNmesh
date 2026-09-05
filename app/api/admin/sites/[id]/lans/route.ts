import { z } from "zod";
import { json, parseBody, withAdmin } from "@/server/http";
import { addLan } from "@/server/sites";

export const dynamic = "force-dynamic";

export const lanSchema = z.object({
  cidr: z.string().min(9).max(18),
  name: z.string().min(1).max(60),
  vlan: z.number().int().nullable().optional(),
  shared: z.boolean().optional(),
});

export const POST = withAdmin<{ id: string }>(async (req, { params, admin }) => {
  const body = await parseBody(req, lanSchema);
  return json(addLan(params.id, body, admin.email), 201);
});
