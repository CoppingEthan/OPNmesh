/**
 * Staged rollout state machine (§11 layers 2, 3, 7, 8).
 *
 * Pure functions over a serializable state so the control server (and later
 * the UI) can persist and resume it. Rules:
 *  - the canary updates first and must soak healthy for soakSec before
 *    anyone else becomes eligible
 *  - one node at a time, never concurrent
 *  - hubs (and relays) update last
 *  - the first failure aborts the entire rollout
 *  - freeze takes effect immediately, including mid-rollout
 *  - pinned nodes are skipped entirely
 *  - the control node itself is not in the plan: it updates only after all
 *    nodes are healthy on the new version (layer 8), via its own process.
 */
import type { ResolvedConfig } from "../schema.js";

export interface ReleaseManifest {
  version: string;
  sha256: string;
  /**
   * Digest of the generated bundle this release's generator produces for the
   * current topology, if the publisher computed one. A digest differing from
   * the control node's own generation blocks the rollout pending explicit
   * approval (§11 hard invariant: updates never change WireGuard config as a
   * side effect).
   */
  configDigest?: string | null;
}

export interface NodeReportView {
  version: string;
  lastError: string;
  lastUpdateError: string;
  lastSeen: number;
}

export interface RolloutState {
  version: string;
  /** Node order: canary first, hubs last. */
  plan: string[];
  idx: number;
  status: "running" | "done" | "aborted";
  soakSec: number;
  failTimeoutSec: number;
  canary: string;
  nodeStatus: Record<string, { startedAt?: number; doneAt?: number }>;
  abortReason?: string;
  createdAt: number;
}

export interface RolloutEvent {
  type: "node-started" | "node-done" | "soak-complete" | "rollout-done" | "rollout-aborted";
  node?: string;
  detail: string;
}

export function planRollout(
  cfg: ResolvedConfig,
  version: string,
  canary: string,
  soakSec: number,
  failTimeoutSec: number,
  now: number,
): RolloutState {
  const ids = cfg.sites.map((s) => s.id);
  if (!ids.includes(canary)) throw new Error(`canary "${canary}" is not a known site`);
  const hubs = cfg.topology.hubs;
  const rest = ids.filter((id) => id !== canary && !hubs.includes(id));
  // Hubs/relays last (§11 layer 3); the canary leads even if it is a hub.
  const hubsLast = hubs.filter((id) => id !== canary);
  return {
    version,
    plan: [canary, ...rest, ...hubsLast],
    idx: 0,
    status: "running",
    soakSec,
    failTimeoutSec,
    canary,
    nodeStatus: {},
    createdAt: now,
  };
}

/** Should this node be handed the update instruction right now? */
export function instructionDue(
  state: RolloutState,
  node: string,
  opts: { frozen: boolean; windowOpen: boolean; pinned: (n: string) => boolean },
): boolean {
  if (state.status !== "running") return false;
  if (opts.frozen || !opts.windowOpen) return false;
  if (state.plan[state.idx] !== node) return false;
  if (opts.pinned(node)) return false;
  return true;
}

/** Mark that the instruction was served (starts the node's failure clock). */
export function markStarted(state: RolloutState, node: string, now: number): RolloutEvent[] {
  const ns = (state.nodeStatus[node] ??= {});
  if (ns.startedAt) return [];
  ns.startedAt = now;
  return [{ type: "node-started", node, detail: `updating to ${state.version}` }];
}

/**
 * Advance the state machine from the latest reports. Skips pinned nodes,
 * enforces soak on the canary, aborts on failure or timeout.
 */
export function advance(
  state: RolloutState,
  reports: Record<string, NodeReportView | undefined>,
  now: number,
  opts: { pinned: (n: string) => boolean },
): RolloutEvent[] {
  const events: RolloutEvent[] = [];
  if (state.status !== "running") return events;

  // Pinned nodes are skipped entirely (they can be updated later by hand);
  // applied both on entry and after every idx move so a pinned node is never
  // "current".
  const skipPinned = () => {
    while (state.idx < state.plan.length && opts.pinned(state.plan[state.idx]!)) {
      events.push({
        type: "node-done",
        node: state.plan[state.idx]!,
        detail: "pinned — skipped",
      });
      state.idx++;
    }
    if (state.idx >= state.plan.length && state.status === "running") {
      state.status = "done";
      events.push({ type: "rollout-done", detail: `all nodes on ${state.version}` });
    }
  };

  skipPinned();
  if (state.status !== "running") return events;

  const node = state.plan[state.idx]!;
  const ns = (state.nodeStatus[node] ??= {});
  const report = reports[node];

  if (report?.lastUpdateError && report.lastUpdateError.includes(state.version)) {
    state.status = "aborted";
    state.abortReason = `${node}: ${report.lastUpdateError}`;
    events.push({ type: "rollout-aborted", node, detail: state.abortReason });
    return events;
  }

  // The soak is carried by the first node that actually updates. That is the
  // canary — unless the canary is pinned/skipped, in which case pinning it
  // must NOT silently void the bake time for the whole fleet; the next
  // eligible node inherits the soak instead.
  const soakCarrier = state.plan.find((n) => !opts.pinned(n));

  if (report && report.version === state.version && report.lastError === "") {
    if (!ns.doneAt) {
      ns.doneAt = now;
      events.push({ type: "node-done", node, detail: `healthy on ${state.version}` });
    }
    const soakNeeded = node === soakCarrier ? state.soakSec : 0;
    if (now - ns.doneAt >= soakNeeded * 1000) {
      if (soakNeeded > 0) {
        events.push({ type: "soak-complete", node, detail: `${state.soakSec}s soak complete` });
      }
      state.idx++;
      if (state.idx >= state.plan.length) {
        state.status = "done";
        events.push({ type: "rollout-done", detail: `all nodes on ${state.version}` });
      } else {
        skipPinned();
      }
    }
    return events;
  }

  // Reached here means the current node is NOT healthy on the target version.
  // If it had previously gone healthy (soak clock running), the health has
  // regressed — restart the clock so the soak measures CONTINUOUS health. A
  // canary that flaps healthy → broken → healthy must not pass the gate it
  // exists to enforce on the strength of its first good report.
  if (ns.doneAt !== undefined) {
    delete ns.doneAt;
    events.push({ type: "node-started", node, detail: `health regressed on ${state.version}; soak restarted` });
  }

  if (ns.startedAt && now - ns.startedAt > state.failTimeoutSec * 1000) {
    state.status = "aborted";
    state.abortReason = `${node}: did not become healthy on ${state.version} within ${state.failTimeoutSec}s`;
    events.push({ type: "rollout-aborted", node, detail: state.abortReason });
  }
  return events;
}
