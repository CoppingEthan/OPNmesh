import { json, withGateway } from "@/server/http";
import { getGenerated } from "@/server/snapshot";
import { getSettings } from "@/server/settings";
import { heldNotice } from "@/core/validate";

export const dynamic = "force-dynamic";

/**
 * The gateway's desired configuration. ETag is the bundle hash for this
 * gateway; an If-None-Match hit returns 304 with no body. While a validation
 * error reaches this gateway's config it is held: 409, and the agent keeps
 * running what it has (telemetry does not advertise the held hash either).
 * The gateway learns only the kind of error and whether it is at its own
 * site; the full message, which can name other sites and their networks,
 * is for the admin.
 */
export const GET = withGateway(async (req, { gateway }) => {
  if (gateway.status === "pending") return json({ status: "pending", message: "waiting for approval in the OPNmesh UI" }, 202);
  if (gateway.status === "disabled") return json({ status: "disabled", message: "this gateway has been disabled" }, 403);
  const gen = getGenerated();
  if (gen.held.gateways[gateway.id] !== undefined) {
    const error = heldNotice(gen.findings, gateway.siteId) ?? "configuration on hold until an error is fixed in the OPNmesh UI";
    return json({ status: "held", error }, 409);
  }
  const entry = gen.bundle.gateways[gateway.id];
  if (!entry) return json({ status: "pending", message: "no configuration generated yet" }, 202);
  const etag = `"${entry.hash}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return json(
    {
      status: "active",
      hash: entry.hash,
      configVersion: gen.version,
      files: entry.files,
      meta: { ...entry.meta, telemetryIntervalSeconds: getSettings().telemetryIntervalS, siteSlug: entry.siteSlug },
    },
    200,
    { ETag: etag },
  );
});
