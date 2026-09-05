import { json, text, withAdmin } from "@/server/http";
import { getSite } from "@/server/sites";
import { getGenerated } from "@/server/snapshot";
import { renderRouterText } from "@/server/router-text";

export const dynamic = "force-dynamic";

/** The router plan for a site, as JSON or (?format=text) plain text. */
export const GET = withAdmin<{ id: string }>(async (req, { params }) => {
  const site = getSite(params.id);
  if (!site) return json({ error: "site not found" }, 404);
  const plan = getGenerated().bundle.routers[params.id];
  if (!plan) return json({ error: "this site has no active gateway yet, so there is nothing to route" }, 409);
  const format = new URL(req.url).searchParams.get("format");
  if (format === "text") return text(renderRouterText(plan, site.name));
  return json({ plan, text: renderRouterText(plan, site.name) });
});
