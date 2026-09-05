import { json, withAdmin } from "@/server/http";
import { requestDiagnostics, siteDiagnostics } from "@/server/diagnostics";

export const dynamic = "force-dynamic";

type P = { id: string };

/** Latest results: controller-side checks computed now, gateway-side from its last run. */
export const GET = withAdmin<P>(async (_req, { params }) => json(await siteDiagnostics(params.id)));

/** Ask the gateway to run its checks; results arrive within a couple of reports. */
export const POST = withAdmin<P>(async (_req, { params, admin }) => {
  const r = requestDiagnostics(params.id, admin.email);
  if (!r) return json({ error: "This site has no gateway yet" }, 404);
  return json(r);
});
