/**
 * A rollout must not abort on an error left over from an earlier attempt.
 *
 * The agent clears its update error when a new attempt begins, so anything
 * the control node sees afterwards is fresh. This test pins the control-side
 * half of that contract: once a node reports healthy on the target version,
 * the rollout advances regardless of what it reported before.
 */
import { describe, expect, it } from "vitest";
import { advance, markStarted, planRollout } from "../lib/update/rollout.js";
import { loadFixture } from "./helpers.js";

const NOW = 1_700_000_000_000;
const noPin = { pinned: () => false };

describe("stale update errors", () => {
  const cfg = loadFixture("reference");

  it("a node that failed once and then succeeds does not abort the next rollout", () => {
    // First attempt fails on the canary.
    const first = planRollout(cfg, "2.0.0", "site-a", 0, 120, NOW);
    markStarted(first, "site-a", NOW);
    advance(
      first,
      {
        "site-a": {
          version: "1.0.0",
          lastError: "",
          lastUpdateError: "update to 2.0.0 failed pre-switch: no minisign public key",
          lastSeen: NOW,
        },
      },
      NOW + 1000,
      noPin,
    );
    expect(first.status).toBe("aborted");

    // Operator fixes the cause and starts a fresh rollout. The agent has
    // cleared its error, so the node reports clean and the rollout proceeds.
    const second = planRollout(cfg, "2.0.0", "site-a", 0, 120, NOW + 60_000);
    markStarted(second, "site-a", NOW + 60_000);
    const healthy = { version: "2.0.0", lastError: "", lastUpdateError: "", lastSeen: NOW + 61_000 };
    advance(second, { "site-a": healthy }, NOW + 61_000, noPin);
    expect(second.status).toBe("running");
    expect(second.plan[second.idx]).toBe("site-b");
  });

  it("an error naming a different version never aborts this rollout", () => {
    const state = planRollout(cfg, "3.0.0", "site-a", 0, 120, NOW);
    markStarted(state, "site-a", NOW);
    advance(
      state,
      {
        "site-a": {
          version: "3.0.0",
          lastError: "",
          // Left over from an unrelated, older attempt.
          lastUpdateError: "update to 2.0.0 rolled back: no handshake",
          lastSeen: NOW,
        },
      },
      NOW + 1000,
      noPin,
    );
    expect(state.status).toBe("running");
    expect(state.plan[state.idx]).toBe("site-b");
  });
});
