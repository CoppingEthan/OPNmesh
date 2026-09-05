/** Plain-text rendering of a router plan, for copy/paste and download. */
import type { RouterPlan } from "@/core/generate/router";

export function renderRouterText(plan: RouterPlan, siteName: string): string {
  const lines: string[] = [
    `# Router setup for ${siteName}`,
    `# Layout: ${layoutName(plan.layout)}`,
    `# Next hop for every route below: ${plan.nextHop} (the OPNmesh gateway)`,
    "",
  ];
  if (plan.layout === "masquerade") {
    lines.push(
      "## No router changes are required for this site.",
      "# Remote sites and roaming clients can reach this site already. Add the",
      "# routes below only if hosts here must open connections to remote sites.",
      "",
    );
  }
  lines.push("## Static routes (destination via next hop)");
  for (const r of plan.routes) lines.push(`${r.cidr.padEnd(20)} via ${plan.nextHop}    # ${r.label}`);
  lines.push("");
  if (plan.portForward) {
    lines.push("## WAN port forward", `${plan.portForward.protocol.toUpperCase()} ${plan.portForward.port} -> ${plan.portForward.toIp}:${plan.portForward.port}    # WireGuard`, "");
  } else {
    lines.push("## WAN port forward", "# None: this site dials out to the other sites and accepts no inbound tunnels.", "");
  }
  lines.push("## Firewall");
  if (plan.allStatesPolicy) {
    lines.push(
      `# Required for the same-LAN layout: allow ALL connection states (including invalid)`,
      `# from the local networks to these destinations, above the default rules:`,
      ...plan.allStatesPolicy.destinations.map((d) => `#   ${d}`),
      "",
    );
  } else if (plan.layout === "transit") {
    lines.push("# Nothing extra with default rules (transit and LAN networks are both internal).", "");
  }
  lines.push(
    "# Optional belt-and-braces: block new connections from local networks to roaming",
    `# clients (${plan.clientBlockPolicy.destination}); the gateway already enforces this.`,
    "",
    "## This site's networks",
    ...plan.localLans.map((l) => `${l.cidr.padEnd(20)} ${l.name}${l.vlan ? ` (VLAN ${l.vlan})` : ""} — ${l.shared ? "shared across the mesh" : "local only, not shared"}`),
  );
  return lines.join("\n") + "\n";
}

export function layoutName(layout: RouterPlan["layout"]): string {
  switch (layout) {
    case "transit":
      return "transit network (recommended)";
    case "same_lan":
      return "same LAN as the hosts";
    case "masquerade":
      return "no router changes (masquerade)";
  }
}
