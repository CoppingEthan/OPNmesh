import { describe, expect, it } from "vitest";
import { advance, instructionDue, markStarted, planRollout } from "../lib/update/rollout.js";
import { loadFixture } from "./helpers.js";

const NOW = 1_700_000_000_000;
const noPin = { pinned: () => false };
const healthy = (version: string) => ({ version, lastError: "", lastUpdateError: "", lastSeen: NOW });
const unhealthy = (version: string) => ({ version, lastError: "tunnel down", lastUpdateError: "", lastSeen: NOW });

describe("rollout planning", () => {
  it("canary first, hubs last", () => {
    const cfg = loadFixture("multi-hub"); // hubs: site-a, site-b
    const state = planRollout(cfg, "2.0.0", "site-c", 30, 60, NOW);
    expect(state.plan).toEqual(["site-c", "site-d", "site-a", "site-b"]);
  });

  it("a hub canary still leads", () => {
    const cfg = loadFixture("multi-hub");
    const state = planRollout(cfg, "2.0.0", "site-a", 30, 60, NOW);
    expect(state.plan).toEqual(["site-a", "site-c", "site-d", "site-b"]);
  });
});

describe("rollout advancement", () => {
  const cfg = loadFixture("reference");

  it("one node at a time with canary soak", () => {
    const state = planRollout(cfg, "2.0.0", "site-a", 30, 60, NOW);
    expect(instructionDue(state, "site-a", { frozen: false, windowOpen: true, pinned: () => false })).toBe(true);
    expect(instructionDue(state, "site-b", { frozen: false, windowOpen: true, pinned: () => false })).toBe(false);

    markStarted(state, "site-a", NOW);
    // Canary healthy on target — but must soak before site-b becomes eligible.
    let events = advance(state, { "site-a": healthy("2.0.0") }, NOW + 5000, noPin);
    expect(events.map((e) => e.type)).toContain("node-done");
    expect(state.idx).toBe(0);

    events = advance(state, { "site-a": healthy("2.0.0") }, NOW + 5000 + 30_000, noPin);
    expect(events.map((e) => e.type)).toContain("soak-complete");
    expect(state.plan[state.idx]).toBe("site-b");

    // Non-canary nodes advance without soak.
    markStarted(state, "site-b", NOW + 40_000);
    advance(state, { "site-a": healthy("2.0.0"), "site-b": healthy("2.0.0") }, NOW + 50_000, noPin);
    expect(state.plan[state.idx]).toBe("site-c");

    markStarted(state, "site-c", NOW + 55_000);
    const done = advance(
      state,
      { "site-a": healthy("2.0.0"), "site-b": healthy("2.0.0"), "site-c": healthy("2.0.0") },
      NOW + 60_000,
      noPin,
    );
    expect(state.status).toBe("done");
    expect(done.map((e) => e.type)).toContain("rollout-done");
  });

  it("a canary that flaps unhealthy mid-soak restarts the soak clock", () => {
    const state = planRollout(cfg, "2.0.0", "site-a", 30, 600, NOW);
    markStarted(state, "site-a", NOW);
    // Healthy at t+1s → soak clock starts.
    advance(state, { "site-a": healthy("2.0.0") }, NOW + 1_000, noPin);
    // Breaks at t+10s (inside the 30s soak).
    advance(state, { "site-a": unhealthy("2.0.0") }, NOW + 10_000, noPin);
    // Healthy again at t+31s: naive code would treat the original t+1s as
    // satisfying the 30s soak. It must NOT — the clock restarted at t+31s.
    const ev = advance(state, { "site-a": healthy("2.0.0") }, NOW + 31_000, noPin);
    expect(ev.map((e) => e.type)).not.toContain("soak-complete");
    expect(state.idx).toBe(0);
    // And it completes only after a further continuous 30s.
    const done = advance(state, { "site-a": healthy("2.0.0") }, NOW + 62_000, noPin);
    expect(done.map((e) => e.type)).toContain("soak-complete");
  });

  it("a pinned canary hands the soak to the next node instead of voiding it", () => {
    const state = planRollout(cfg, "2.0.0", "site-a", 30, 600, NOW);
    const pinA = { pinned: (n: string) => n === "site-a" };
    // site-a is pinned → skipped; site-b becomes current and must now carry
    // the soak rather than updating with zero bake time.
    advance(state, {}, NOW, pinA);
    expect(state.plan[state.idx]).toBe("site-b");
    markStarted(state, "site-b", NOW);
    const early = advance(state, { "site-b": healthy("2.0.0") }, NOW + 5_000, pinA);
    expect(early.map((e) => e.type)).not.toContain("soak-complete");
    expect(state.idx).toBe(1); // still on site-b, soaking
    const soaked = advance(state, { "site-b": healthy("2.0.0") }, NOW + 35_000, pinA);
    expect(soaked.map((e) => e.type)).toContain("soak-complete");
  });

  it("a reported update failure aborts the whole rollout", () => {
    const state = planRollout(cfg, "2.0.0", "site-a", 0, 60, NOW);
    markStarted(state, "site-a", NOW);
    const events = advance(
      state,
      {
        "site-a": {
          version: "1.0.0",
          lastError: "",
          lastUpdateError: "update to 2.0.0 rolled back: no handshake+check-in within 20s",
          lastSeen: NOW,
        },
      },
      NOW + 30_000,
      noPin,
    );
    expect(state.status).toBe("aborted");
    expect(state.abortReason).toContain("site-a");
    expect(events[0]!.type).toBe("rollout-aborted");
  });

  it("a node that never becomes healthy times out and aborts", () => {
    const state = planRollout(cfg, "2.0.0", "site-a", 0, 60, NOW);
    markStarted(state, "site-a", NOW);
    advance(state, {}, NOW + 61_000, noPin);
    expect(state.status).toBe("aborted");
    expect(state.abortReason).toContain("within 60s");
  });

  it("freeze withholds instructions immediately, mid-rollout", () => {
    const state = planRollout(cfg, "2.0.0", "site-a", 0, 60, NOW);
    expect(instructionDue(state, "site-a", { frozen: true, windowOpen: true, pinned: () => false })).toBe(false);
    expect(instructionDue(state, "site-a", { frozen: false, windowOpen: false, pinned: () => false })).toBe(false);
  });

  it("pinned nodes are skipped, not blocked on", () => {
    const state = planRollout(cfg, "2.0.0", "site-a", 0, 60, NOW);
    const pinnedB = { pinned: (n: string) => n === "site-b" };
    markStarted(state, "site-a", NOW);
    advance(state, { "site-a": healthy("2.0.0") }, NOW + 1000, pinnedB);
    // site-b skipped → site-c is current.
    expect(state.plan[state.idx]).toBe("site-c");
    advance(state, { "site-a": healthy("2.0.0"), "site-c": healthy("2.0.0") }, NOW + 2000, pinnedB);
    expect(state.status).toBe("done");
  });
});
