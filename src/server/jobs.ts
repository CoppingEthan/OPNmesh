/**
 * Background jobs, started once per process from instrumentation.ts:
 * telemetry rollups, expiry and pruning, and the setup-code banner.
 */
import { needsSetup, pruneSessions, setupCode } from "./auth";
import { expireClients, pruneInvites } from "./clients";
import { pruneEvents } from "./events";
import { env } from "./env";
import { getDb } from "@/db";
import { pruneEnrolTokens } from "./sites";
import { runRollups } from "./telemetry";
import { syncDueLinks } from "./unifi";
import { liveSeries } from "./live-series";
import { checkGatewayAlerts } from "./alerts";

const g = globalThis as unknown as { __opnmeshJobs?: boolean };

export function startBackgroundJobs(): void {
  if (g.__opnmeshJobs) return;
  g.__opnmeshJobs = true;
  const e = env();
  getDb();
  console.log(`[opnmesh] controller starting; data in ${e.dataDir}; public URL ${e.publicUrl}`);
  if (needsSetup()) {
    console.log("");
    console.log("==========================================================");
    console.log(`  OPNmesh first-run setup code:  ${setupCode()}`);
    console.log(`  Open ${e.publicUrl}/setup and enter it to create the admin account.`);
    console.log("==========================================================");
    console.log("");
  }
  const safely = (name: string, fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      console.error(`[opnmesh] job ${name} failed:`, err);
    }
  };
  setInterval(() => safely("rollups", runRollups), 60_000).unref();
  // One per-site throughput sample a second feeds the live graph.
  setInterval(() => safely("live-series", () => liveSeries().sample(Date.now())), 1000).unref();
  // Gateway down / back-up emails.
  setInterval(() => {
    checkGatewayAlerts().catch((err) => console.error("[opnmesh] job alerts failed:", err));
  }, 15_000).unref();
  // UniFi: push routes when the topology changed (checked every 20 s) or every 10 min.
  setInterval(() => {
    syncDueLinks().catch((err) => console.error("[opnmesh] job unifi-sync failed:", err));
  }, 20_000).unref();
  setInterval(() => {
    safely("expire-clients", expireClients);
    safely("prune-tokens", pruneEnrolTokens);
    safely("prune-invites", pruneInvites);
    safely("prune-sessions", pruneSessions);
    safely("prune-events", () => pruneEvents(365 * 24 * 3600 * 1000));
  }, 10 * 60_000).unref();
  // Run once soon after start so a restart does not delay maintenance.
  setTimeout(() => {
    safely("rollups", runRollups);
    safely("expire-clients", expireClients);
  }, 15_000).unref();
}
