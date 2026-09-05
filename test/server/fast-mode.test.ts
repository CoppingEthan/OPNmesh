import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { addLan, createEnrolToken, createSite, enrolGateway, getSite } from "@/server/sites";
import { ingestTelemetry } from "@/server/telemetry";
import { FAST_MODE_GRACE_MS, liveState, telemetrySchema } from "@/server/live";
import { generateKeyPair } from "@/core/crypto";
import { getSettings } from "@/server/settings";

let now = 1_800_000_000_000;

beforeEach(() => {
  freshDb();
  liveState().resetFastModeForTests();
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  liveState().resetFastModeForTests();
  vi.restoreAllMocks();
});

describe("adaptive reporting", () => {
  it("asks for one-second reports while an overview is open, with a grace period after", () => {
    const site = createSite({ name: "Datacentre", routerLayout: "transit", hubPriority: 1 }, "t");
    addLan(site.id, { cidr: "10.0.1.0/24", name: "Servers" }, "t");
    const { token } = createEnrolToken(site.id);
    const r = enrolGateway({ token, publicKey: generateKeyPair().publicKey, hostname: "gw", os: "", arch: "", addresses: ["10.0.250.2"], agentVersion: "1" });
    if (!r.ok) throw new Error(r.reason);
    const gw = getSite(site.id)!.gateway!;
    const report = () => telemetrySchema.parse({ version: "1", interfaceUp: true, peers: [], counters: [] });

    expect(ingestTelemetry(gw, report()).intervalSeconds).toBe(getSettings().telemetryIntervalS);
    liveState().addFastViewer();
    expect(ingestTelemetry(gw, report()).intervalSeconds).toBe(1);
    liveState().removeFastViewer();
    // Still fast within the grace window, so a page reload does not flap.
    now += FAST_MODE_GRACE_MS / 2;
    expect(ingestTelemetry(gw, report()).intervalSeconds).toBe(1);
    now += FAST_MODE_GRACE_MS;
    expect(ingestTelemetry(gw, report()).intervalSeconds).toBe(getSettings().telemetryIntervalS);
    // Never negative, and viewers count.
    liveState().removeFastViewer();
    liveState().addFastViewer();
    liveState().addFastViewer();
    liveState().removeFastViewer();
    expect(liveState().fastMode(now)).toBe(true);
  });
});
