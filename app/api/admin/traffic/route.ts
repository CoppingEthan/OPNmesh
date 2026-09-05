import { json, withAdmin } from "@/server/http";
import { pairSeries, peerSeries, siteSeries, RANGES, type Range } from "@/server/telemetry";
import { getGenerated } from "@/server/snapshot";
import { meshSites } from "@/core/topology";

export const dynamic = "force-dynamic";

/**
 * Historical series.
 *   ?range=24h&sites=1                              every site's total in/out (the overview graph)
 *   ?range=24h&from=<site slug>&to=<site slug>      routed bytes/s between two sites
 *   ?range=24h&gateway=<id>&peer=<public key>       one tunnel as seen by one gateway
 */
export const GET = withAdmin(async (req) => {
  const u = new URL(req.url);
  const range = (u.searchParams.get("range") ?? "24h") as Range;
  if (!RANGES.includes(range)) return json({ error: `range must be one of ${RANGES.join(", ")}` }, 400);
  if (u.searchParams.get("sites") === "1") {
    const gen = getGenerated();
    const sites = meshSites(gen.snapshot).map((s) => ({ siteId: s.id, name: s.name, points: siteSeries(s.gateway.id, range) }));
    return json({ range, sites });
  }
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");
  const gateway = u.searchParams.get("gateway");
  const peer = u.searchParams.get("peer");
  if (from && to) return json({ range, points: pairSeries(from, to, range) });
  if (gateway && peer) return json({ range, points: peerSeries(gateway, peer, range) });
  return json({ error: "specify sites=1, from+to, or gateway+peer" }, 400);
});
