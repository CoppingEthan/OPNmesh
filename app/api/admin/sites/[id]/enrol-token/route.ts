import { z } from "zod";
import { json, parseBody, withAdmin } from "@/server/http";
import { gatewayCommand } from "@/server/install-script";
import { createEnrolToken, getSite } from "@/server/sites";

export const dynamic = "force-dynamic";

const schema = z.object({ autoApprove: z.boolean().optional() });

/** Issue a one-time enrolment token and the install one-liner that carries it. */
export const POST = withAdmin<{ id: string }>(async (req, { params, admin }) => {
  const site = getSite(params.id);
  if (!site) return json({ error: "site not found" }, 404);
  const body = await parseBody(req, schema);
  const { token, expiresAt } = createEnrolToken(params.id, { autoApprove: body.autoApprove ?? true }, admin.email);
  return json({
    token,
    expiresAt,
    ...gatewayCommand({ token }),
    replaces: site.gateway ? site.gateway.hostname || site.gateway.name : null,
  });
});
