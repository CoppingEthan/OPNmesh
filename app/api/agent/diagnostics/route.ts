import { json, parseBody, withGateway } from "@/server/http";
import { agentDiagReportSchema, storeAgentReport } from "@/server/diagnostics";

export const dynamic = "force-dynamic";

/** A gateway's answer to a health-check request it received with its telemetry response. */
export const POST = withGateway(async (req, { gateway }) => {
  if (gateway.status !== "active") return json({ error: `this gateway is ${gateway.status}` }, 403);
  const report = await parseBody(req, agentDiagReportSchema);
  if (!storeAgentReport(gateway, report)) return json({ error: "no health check is waiting for this answer" }, 409);
  return json({ ok: true });
});
