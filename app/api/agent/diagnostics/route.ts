import { json, parseBody, withGateway } from "@/server/http";
import { agentDiagReportSchema, storeAgentReport } from "@/server/diagnostics";

export const dynamic = "force-dynamic";

/** A gateway's answer to a health-check request it received with its telemetry response. */
export const POST = withGateway(async (req, { gateway }) => {
  const report = await parseBody(req, agentDiagReportSchema);
  const stored = storeAgentReport(gateway, report);
  return json({ ok: stored });
});
