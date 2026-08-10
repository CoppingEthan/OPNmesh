/**
 * Live feed for the dashboard diagram. Behind the same session gate as every
 * page — the graph exposes the full topology.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "../../../lib/ui/auth.js";
import { loadSites } from "../../../lib/ui/sites.js";
import { control } from "../../../lib/ui/control.js";
import { buildMeshGraph, type LiveNodeState } from "../../../lib/ui/graph.js";
import { toRateLookup } from "../../../lib/ui/rates.js";

export const dynamic = "force-dynamic";

export async function GET() {
  await requireAdmin();
  const sites = loadSites();
  const state = await control
    .state()
    .catch(() => ({
      nodes: {} as Record<string, LiveNodeState | undefined>,
      rates: undefined as Record<string, { aToB: number; bToA: number }> | undefined,
    }));
  const live = state.nodes as Record<string, LiveNodeState | undefined>;
  const graph = buildMeshGraph(sites.cfg, live, toRateLookup(state.rates));
  return NextResponse.json(graph, { headers: { "cache-control": "no-store" } });
}
