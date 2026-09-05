/**
 * What the top status bar shows, derived from one state payload. Kept out of
 * the client component so the layout can compute it on the server for the
 * first paint.
 */
import type { StatePayload } from "@/server/state";

export interface StatusSummary {
  level: "ok" | "warn" | "bad" | "empty";
  title: string;
  sitesOnline: number;
  sitesTotal: number;
  tunnelsUp: number;
  tunnelsTotal: number;
  clientsOnline: number;
  clientsTotal: number;
  inSync: number;
  syncTotal: number;
  problems: number;
  version: string;
}

export function summarise(state: StatePayload, version: string): StatusSummary {
  const inMesh = state.sites.filter((s) => s.inMesh);
  const direct = state.tunnels.filter((t) => t.kind === "direct");
  const withGateway = state.sites.filter((s) => s.gateway);
  return {
    level: state.headline.level,
    title: state.headline.title,
    sitesOnline: inMesh.filter((s) => s.gateway?.health === "online").length,
    sitesTotal: state.sites.length,
    tunnelsUp: direct.filter((t) => t.health === "up").length,
    tunnelsTotal: direct.length,
    clientsOnline: state.clients.filter((c) => c.online).length,
    clientsTotal: state.clients.length,
    inSync: withGateway.filter((s) => s.gateway?.configCurrent).length,
    syncTotal: withGateway.length,
    problems: state.findings.length,
    version,
  };
}
