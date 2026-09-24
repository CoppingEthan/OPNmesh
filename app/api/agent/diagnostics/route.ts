import { json, rateLimited, withGateway } from "@/server/http";
import { agentDiagReportSchema, awaitingAgentReport, storeAgentReport } from "@/server/diagnostics";
import { DIAGNOSTICS_MAX_BODY, parseAgentBody } from "../_lib/body";

export const dynamic = "force-dynamic";

const NOT_ASKED = "no health check is waiting for this answer";

/**
 * A gateway's answer to a health-check request it received with its
 * telemetry response. Nothing is read unless a request is waiting for an
 * answer, and a gateway gets a few tries a minute, so a gateway token
 * cannot make the controller parse report after report.
 */
export const POST = withGateway(async (req, { gateway }) => {
  if (gateway.status !== "active") return json({ error: `this gateway is ${gateway.status}` }, 403);
  if (!awaitingAgentReport(gateway)) return json({ error: NOT_ASKED }, 409);
  if (rateLimited(`diagnostics:${gateway.id}`, 10, 60_000)) return json({ error: "too many health-check answers" }, 429);
  const report = await parseAgentBody(req, agentDiagReportSchema, DIAGNOSTICS_MAX_BODY);
  if (!storeAgentReport(gateway, report)) return json({ error: NOT_ASKED }, 409);
  return json({ ok: true });
});
