import { json, withGateway } from "@/server/http";
import { getGenerated } from "@/server/snapshot";
import { getSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

/**
 * The gateway's desired configuration. ETag is the bundle hash for this
 * gateway; an If-None-Match hit returns 304 with no body.
 */
export const GET = withGateway(async (req, { gateway }) => {
  if (gateway.status === "pending") return json({ status: "pending", message: "waiting for approval in the OPNmesh UI" }, 202);
  if (gateway.status === "disabled") return json({ status: "disabled", message: "this gateway has been disabled" }, 403);
  const gen = getGenerated();
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
