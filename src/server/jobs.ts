/**
 * Background jobs, started once per process from instrumentation.ts:
 * telemetry rollups, expiry and pruning, and the setup-code banner. They
 * stop when the controller does (see shutdown.ts).
 */
import { needsSetup, pruneSessions, setupCode } from "./auth";
import { removeStaleBackups } from "./backup";
import { expireClients, pruneInvites } from "./clients";
import { pruneEvents } from "./events";
import { env } from "./env";
import { getDb } from "@/db";
import { pruneEnrolTokens } from "./sites";
import { runRollups } from "./telemetry";
import { syncDueLinks } from "./unifi";
import { liveSeries } from "./live-series";
import { checkGatewayAlerts } from "./alerts";
import { onShutdown } from "./shutdown";

type Timer = ReturnType<typeof setInterval>;

const g = globalThis as unknown as { __opnmeshJobs?: boolean; __opnmeshJobTimers?: Timer[] };

export function startBackgroundJobs(): void {
  if (g.__opnmeshJobs) return;
  g.__opnmeshJobs = true;
  const e = env();
  getDb();
  console.log(`[opnmesh] controller starting; data in ${e.dataDir}; public URL ${e.publicUrl}`);
  removeStaleBackups();
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
  const timers: Timer[] = (g.__opnmeshJobTimers = []);
  const every = (ms: number, fn: () => void) => {
    timers.push(setInterval(fn, ms).unref());
  };
  every(60_000, () => safely("rollups", runRollups));
  // One per-site throughput sample a second feeds the live graph.
  every(1000, () => safely("live-series", () => liveSeries().sample(Date.now())));
  // Gateway down / back-up emails.
  every(15_000, () => {
    checkGatewayAlerts().catch((err) => console.error("[opnmesh] job alerts failed:", err));
  });
  // UniFi: push routes when the topology changed (checked every 20 s) or every 10 min.
  every(20_000, () => {
    syncDueLinks().catch((err) => console.error("[opnmesh] job unifi-sync failed:", err));
  });
  every(10 * 60_000, () => {
    safely("expire-clients", expireClients);
    safely("prune-tokens", pruneEnrolTokens);
    safely("prune-invites", pruneInvites);
    safely("prune-sessions", pruneSessions);
    safely("prune-events", () => pruneEvents(365 * 24 * 3600 * 1000));
  });
  // Run once soon after start so a restart does not delay maintenance.
  timers.push(
    setTimeout(() => {
      safely("rollups", runRollups);
      safely("expire-clients", expireClients);
    }, 15_000).unref(),
  );
  onShutdown(stopBackgroundJobs);
}

/** Stops every job timer; a job already running finishes on its own. */
export function stopBackgroundJobs(): void {
  for (const t of g.__opnmeshJobTimers ?? []) clearTimeout(t);
  g.__opnmeshJobTimers = [];
}
