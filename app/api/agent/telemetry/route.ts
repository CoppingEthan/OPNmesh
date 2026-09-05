import { json, parseBody, withGateway } from "@/server/http";
import { telemetrySchema } from "@/server/live";
import { ingestTelemetry } from "@/server/telemetry";
import { pendingAgentRequest } from "@/server/diagnostics";

export const dynamic = "force-dynamic";

/**
 * Periodic report from a gateway. The response carries the hash of the
 * configuration the gateway should be running, so a change is fetched on the
 * very next tick without a second polling loop, plus any action the admin has
 * asked for (currently: run the health checks).
 */
export const POST = withGateway(async (req, { gateway }) => {
  const report = await parseBody(req, telemetrySchema);
  if (gateway.status !== "active") {
    return json({ status: gateway.status, configHash: "", intervalSeconds: 15, actions: [] }, 200);
  }
  const out = ingestTelemetry(gateway, report);
  const diag = pendingAgentRequest(gateway);
  return json({ status: "active", ...out, actions: diag ? [{ type: "diagnose", request: diag }] : [] });
});
