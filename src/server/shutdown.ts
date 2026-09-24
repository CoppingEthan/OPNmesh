/**
 * Stopping cleanly on SIGTERM (docker stop) or SIGINT.
 *
 * The image runs `node server.js` as PID 1. Next's own handler closes the
 * HTTP server and waits for every open response before it exits, and a
 * dashboard's live stream stays open for up to fifteen minutes, so docker
 * ran out of patience and killed the process. On a signal the controller
 * now stops its jobs and ends the live streams at once, which lets Next's
 * close finish; the database is checkpointed and closed on the way out; and
 * if something still holds the process after a few seconds, it closes the
 * database and exits anyway.
 */
import { getDb } from "@/db";

/** How long requests get to finish before the controller exits regardless. */
export const SHUTDOWN_DEADLINE_MS = 5000;

interface ShutdownState {
  hooks: Set<() => void>;
  stopping: boolean;
  installed: boolean;
}

const g = globalThis as unknown as { __opnmeshShutdown?: ShutdownState };
const state = (g.__opnmeshShutdown ??= { hooks: new Set(), stopping: false, installed: false });

/** Runs `fn` when the controller begins to stop. Returns a function that cancels it. */
export function onShutdown(fn: () => void): () => void {
  state.hooks.add(fn);
  return () => {
    state.hooks.delete(fn);
  };
}

/** True once a stop has begun: new long-lived work should be refused. */
export function stopping(): boolean {
  return state.stopping;
}

/** Called once per process, from instrumentation.ts. */
export function installShutdownHandlers(): void {
  if (state.installed) return;
  state.installed = true;
  process.once("SIGTERM", () => beginShutdown("SIGTERM"));
  process.once("SIGINT", () => beginShutdown("SIGINT"));
  process.once("exit", afterExit);
}

/** The last thing the process does, however it exits. */
export function afterExit(code: number): void {
  closeDatabase();
  // Next exits with 128 + the signal number once its server has closed; a
  // stop that was asked for and completed is a success.
  if (state.stopping && (code === 130 || code === 143)) process.exitCode = 0;
}

/**
 * Runs the stop hooks (background jobs, live streams), then leaves Next to
 * finish the requests in flight. `exit` and `deadlineMs` are for tests.
 */
export function beginShutdown(signal: string, exit: (code: number) => void = (code) => process.exit(code), deadlineMs = SHUTDOWN_DEADLINE_MS): void {
  if (state.stopping) return;
  state.stopping = true;
  console.log(`[opnmesh] ${signal} received: stopping`);
  const hooks = [...state.hooks];
  state.hooks.clear();
  for (const fn of hooks) {
    try {
      fn();
    } catch (e) {
      console.error("[opnmesh] a stop hook failed:", e);
    }
  }
  setTimeout(() => {
    console.log(`[opnmesh] requests still open after ${deadlineMs / 1000} s; exiting anyway`);
    closeDatabase();
    exit(0);
  }, deadlineMs);
}

/** Writes the write-ahead log back into the database file and closes it; safe to call twice. */
export function closeDatabase(): void {
  try {
    const sqlite = getDb().$client;
    if (!sqlite.open) return;
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    sqlite.close();
  } catch (e) {
    console.error("[opnmesh] closing the database failed:", e);
  }
}

/** Tests: forget a stop that has begun, and every hook. */
export function resetShutdownForTests(): void {
  state.stopping = false;
  state.hooks.clear();
}
