import { errorResponse, json, withAdmin } from "@/server/http";
import { getLink, linkView, syncLink, UnifiLinkError } from "@/server/unifi";
import { UnifiError } from "@/server/unifi/client";

export const dynamic = "force-dynamic";

/** Push this site's routes (and policy) to its console now. */
export const POST = withAdmin<{ id: string }>(async (_req, { params, admin }) => {
  try {
    const result = await syncLink(params.id, admin.email);
    const row = getLink(params.id);
    return json({ result, link: row ? linkView(row) : null });
  } catch (e) {
    if (e instanceof UnifiLinkError) return json({ error: e.message }, e.status);
    if (e instanceof UnifiError) return json({ error: e.message }, 502);
    return errorResponse(e);
  }
});
