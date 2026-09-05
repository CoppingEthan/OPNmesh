/**
 * Make a UniFi console's routes (and, for the same-LAN layout, its firewall
 * policy) equal to what a site's router plan says, touching only objects
 * OPNmesh created. Pure planning functions plus one executor, so the plan can
 * be unit-tested and shown as a preview before anything is written.
 */
import type { RouterPlan } from "@/core/generate/router";
import type { UnifiClient, UnifiFirewallPolicy, UnifiRoute, UnifiZone } from "./client";

export const MANAGED_PREFIX = "OPNmesh:";

export interface ManagedIds {
  /** cidr → route _id */
  routes: Record<string, string>;
  /** the all-states firewall policy _id, when created */
  policy?: string;
}

export function desiredRoutes(plan: RouterPlan): UnifiRoute[] {
  return plan.routes
    .filter((r) => r.required)
    .map((r) => ({
      name: r.objectName.startsWith(MANAGED_PREFIX) ? r.objectName : `${MANAGED_PREFIX} ${r.objectName}`,
      enabled: true,
      type: "static-route",
      "static-route_network": r.cidr,
      "static-route_type": "nexthop-route",
      "static-route_nexthop": plan.nextHop,
      "static-route_distance": 1,
    }));
}

export function isManagedRoute(r: UnifiRoute, managed: ManagedIds): boolean {
  return (r._id !== undefined && Object.values(managed.routes).includes(r._id)) || r.name.startsWith(MANAGED_PREFIX);
}

export function routeDiffers(existing: UnifiRoute, desired: UnifiRoute): boolean {
  return (
    existing.name !== desired.name ||
    existing.enabled !== desired.enabled ||
    existing["static-route_network"] !== desired["static-route_network"] ||
    existing["static-route_type"] !== desired["static-route_type"] ||
    (existing["static-route_nexthop"] ?? "") !== (desired["static-route_nexthop"] ?? "") ||
    Number(existing["static-route_distance"]) !== desired["static-route_distance"]
  );
}

export interface RoutePlanStep {
  action: "create" | "update" | "delete" | "keep";
  route: UnifiRoute;
  id?: string;
}

/** Decide, without touching the console, what to do about each route. */
export function planRoutes(existing: UnifiRoute[], desired: UnifiRoute[], managed: ManagedIds): RoutePlanStep[] {
  const steps: RoutePlanStep[] = [];
  const ours = existing.filter((r) => isManagedRoute(r, managed));
  const byCidr = new Map(ours.map((r) => [r["static-route_network"], r]));
  const seen = new Set<string>();
  for (const d of desired) {
    const cidr = d["static-route_network"];
    const cur = byCidr.get(cidr);
    if (cur && cur._id) {
      seen.add(cur._id);
      steps.push(routeDiffers(cur, d) ? { action: "update", route: d, id: cur._id } : { action: "keep", route: cur, id: cur._id });
    } else {
      steps.push({ action: "create", route: d });
    }
  }
  for (const r of ours) {
    if (r._id && !seen.has(r._id)) steps.push({ action: "delete", route: r, id: r._id });
  }
  return steps;
}

export function desiredPolicy(plan: RouterPlan, zones: UnifiZone[]): UnifiFirewallPolicy | null {
  if (!plan.allStatesPolicy) return null;
  const internal = zones.find((z) => z.name.toLowerCase() === "internal") ?? zones.find((z) => z.default_zone);
  if (!internal) return null;
  return {
    name: `${MANAGED_PREFIX} allow all states to remote sites (${plan.siteSlug})`,
    enabled: true,
    action: "ALLOW",
    predefined: false,
    protocol: "all",
    ip_version: "IPV4",
    connection_state_type: "ALL",
    logging: false,
    schedule: { mode: "ALWAYS" },
    source: { zone_id: internal._id, matching_target: "ANY", port_matching_type: "ANY" },
    destination: { zone_id: internal._id, matching_target: "IP", ips: plan.allStatesPolicy.destinations, port_matching_type: "ANY" },
  };
}

export function policyDiffers(existing: UnifiFirewallPolicy, desired: UnifiFirewallPolicy): boolean {
  const ips = (p: UnifiFirewallPolicy) => [...(p.destination.ips ?? [])].sort().join(",");
  return existing.name !== desired.name || existing.enabled !== desired.enabled || existing.action !== desired.action || ips(existing) !== ips(desired) || existing.connection_state_type !== desired.connection_state_type;
}

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  managed: ManagedIds;
  /** Whether the WAN port forward the plan needs already exists (checked, never created). */
  portForwardPresent: boolean | null;
  policy: "created" | "updated" | "unchanged" | "deleted" | "unsupported" | "n/a";
  warnings: string[];
}

export async function syncSite(client: UnifiClient, plan: RouterPlan, managed: ManagedIds): Promise<SyncResult> {
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, unchanged: 0, managed: { routes: { ...managed.routes }, policy: managed.policy }, portForwardPresent: null, policy: "n/a", warnings: [] };

  const existing = await client.listRoutes();
  for (const step of planRoutes(existing, desiredRoutes(plan), managed)) {
    const cidr = step.route["static-route_network"];
    switch (step.action) {
      case "create": {
        const created = await client.createRoute(step.route);
        if (created._id) result.managed.routes[cidr] = created._id;
        result.created++;
        break;
      }
      case "update":
        await client.updateRoute(step.id!, step.route);
        result.managed.routes[cidr] = step.id!;
        result.updated++;
        break;
      case "delete":
        await client.deleteRoute(step.id!);
        for (const [k, v] of Object.entries(result.managed.routes)) if (v === step.id) delete result.managed.routes[k];
        result.deleted++;
        break;
      case "keep":
        result.managed.routes[cidr] = step.id!;
        result.unchanged++;
        break;
    }
  }

  if (plan.portForward) {
    try {
      const pfs = await client.listPortForwards();
      result.portForwardPresent = pfs.some((p) => p.enabled !== false && p.proto.toLowerCase().includes("udp") && String(p.dst_port) === String(plan.portForward!.port) && p.fwd === plan.portForward!.toIp);
      if (!result.portForwardPresent) result.warnings.push(`No port forward for UDP ${plan.portForward.port} → ${plan.portForward.toIp} was found; add it by hand so other sites can connect here.`);
    } catch (e) {
      result.warnings.push(`Could not check port forwards: ${(e as Error).message}`);
    }
  }

  if (plan.allStatesPolicy) {
    try {
      const zones = await client.listZones();
      const desired = desiredPolicy(plan, zones);
      const policies = await client.listFirewallPolicies();
      const ours = policies.find((p) => (managed.policy && p._id === managed.policy) || p.name.startsWith(`${MANAGED_PREFIX} allow all states to remote sites (${plan.siteSlug})`));
      if (!desired) {
        result.policy = "unsupported";
        result.warnings.push("Could not find the Internal zone on the console; create the all-states firewall policy by hand.");
      } else if (ours && ours._id) {
        if (policyDiffers(ours, desired)) {
          await client.updateFirewallPolicy(ours._id, { ...ours, ...desired });
          result.policy = "updated";
        } else result.policy = "unchanged";
        result.managed.policy = ours._id;
      } else {
        const created = await client.createFirewallPolicy(desired);
        result.managed.policy = created._id;
        result.policy = "created";
      }
    } catch (e) {
      result.policy = "unsupported";
      result.warnings.push(`Firewall policy not synced (this console may not expose the zone firewall API): ${(e as Error).message}. Create it by hand as shown on the router page.`);
    }
  } else if (managed.policy) {
    try {
      await client.deleteFirewallPolicy(managed.policy);
      result.policy = "deleted";
    } catch (e) {
      result.warnings.push(`Could not remove the old firewall policy: ${(e as Error).message}`);
    }
    delete result.managed.policy;
  }

  return result;
}

/** Remove everything OPNmesh created on the console (when unlinking). */
export async function removeAll(client: UnifiClient, managed: ManagedIds): Promise<{ deleted: number; warnings: string[] }> {
  let deleted = 0;
  const warnings: string[] = [];
  const existing = await client.listRoutes();
  for (const r of existing) {
    if (!r._id || !isManagedRoute(r, managed)) continue;
    try {
      await client.deleteRoute(r._id);
      deleted++;
    } catch (e) {
      warnings.push(`route ${r["static-route_network"]}: ${(e as Error).message}`);
    }
  }
  if (managed.policy) {
    try {
      await client.deleteFirewallPolicy(managed.policy);
      deleted++;
    } catch (e) {
      warnings.push(`firewall policy: ${(e as Error).message}`);
    }
  }
  return { deleted, warnings };
}
