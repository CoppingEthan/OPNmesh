import { z } from "zod";
import { json, parseBody, withAdmin } from "@/server/http";
import { removeGateway, updateGateway } from "@/server/sites";
import { liveState } from "@/server/live";
import { getSite } from "@/server/sites";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(1).max(80).optional(),
  lanIp: z.string().max(15).optional(),
  endpointHost: z.string().max(253).nullable().optional(),
  listenPort: z.number().int().nullable().optional(),
  mtu: z.number().int().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

type P = { id: string };

export const PATCH = withAdmin<P>(async (req, { params, admin }) => {
  const body = await parseBody(req, schema);
  return json(updateGateway(params.id, body, admin.email));
});

export const DELETE = withAdmin<P>(async (_req, { params, admin }) => {
  const site = getSite(params.id);
  if (site?.gateway) liveState().forget(site.gateway.id);
  removeGateway(params.id, admin.email);
  return json({ ok: true });
});
