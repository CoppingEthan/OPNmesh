import { json, withGateway } from "@/server/http";
import { now } from "@/server/env";
import { telemetrySchema } from "@/server/live";
import { admitTelemetry, storeTelemetry } from "@/server/telemetry";
import { pendingAgentRequest } from "@/server/diagnostics";
import { TELEMETRY_MAX_BODY, parseAgentBody } from "../_lib/body";

export const dynamic = "force-dynamic";

/**
 * Periodic report from a gateway. The response carries the hash of the
 * configuration the gateway should be running, so a change is fetched on the
 * very next tick without a second polling loop, plus any action the admin has
 * asked for (currently: run the health checks). A report sent sooner than the
 * gateway was asked gets the same answer but is not stored, nor even read:
 * the answer never depends on the report, so the body is parsed only once
 * the report is known to be kept (see admitTelemetry).
 */
export const POST = withGateway(async (req, { gateway }) => {
  if (gateway.status !== "active") {
    return json({ status: gateway.status, configHash: "", intervalSeconds: 15, actions: [] }, 200);
  }
  const t = now();
  const { outcome, admitted } = admitTelemetry(gateway, t);
  if (admitted) storeTelemetry(gateway, await parseAgentBody(req, telemetrySchema, TELEMETRY_MAX_BODY), t);
  const diag = pendingAgentRequest(gateway, t);
  return json({ status: "active", ...outcome, actions: diag ? [{ type: "diagnose", request: diag }] : [] });
});
