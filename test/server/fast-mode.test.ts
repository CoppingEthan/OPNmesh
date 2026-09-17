import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { addLan, createEnrolToken, createSite, enrolGateway, getSite, updateGateway } from "@/server/sites";
import { ingestTelemetry } from "@/server/telemetry";
import { FAST_MODE_GRACE_MS, liveState, telemetrySchema } from "@/server/live";
import { generateKeyPair } from "@/core/crypto";
import { getSettings } from "@/server/settings";
import { getDb } from "@/db";
import { telemetry5s } from "@/db/schema";

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

  it("stores every report at one a second, and none on the way back to the configured interval", () => {
    const dc = createSite({ name: "Datacentre", hubPriority: 1 }, "t");
    addLan(dc.id, { cidr: "10.0.1.0/24", name: "Servers" }, "t");
    const shop = createSite({ name: "Shop", hubPriority: 2 }, "t");
    addLan(shop.id, { cidr: "10.40.0.0/24", name: "Floor" }, "t");
    const shopKey = generateKeyPair().publicKey;
    for (const [s, key, addr] of [
      [dc, generateKeyPair().publicKey, "10.0.250.2"],
      [shop, shopKey, "10.40.0.2"],
    ] as const) {
      const { token } = createEnrolToken(s.id);
      const r = enrolGateway({ token, publicKey: key, hostname: "gw", os: "", arch: "", addresses: [addr], agentVersion: "1" });
      if (!r.ok) throw new Error(r.reason);
    }
    updateGateway(dc.id, { endpointHost: "dc.example.com" }, "t");
    const gw = getSite(dc.id)!.gateway!;
    let bytes = 0;
    let stored = 0;
    const tick = (waitMs: number) => {
      now += waitMs;
      bytes += 1000;
      const out = ingestTelemetry(gw, telemetrySchema.parse({ version: `v${bytes}`, peers: [{ publicKey: shopKey, rxBytes: bytes, txBytes: bytes }] }));
      if (liveState().get(gw.id)!.report.version === `v${bytes}`) stored++;
      return out.intervalSeconds;
    };

    // The agent sleeps whatever the last answer said, plus up to a fifth.
    let interval = tick(0);
    liveState().addFastViewer();
    for (let i = 0; i < 60; i++) interval = tick(interval * 1000 + ((i * 53) % 200));
    expect(interval).toBe(1);
    const fastRows = getDb().select().from(telemetry5s).all().length;
    liveState().removeFastViewer();
    for (let i = 0; i < 30; i++) interval = tick(interval * 1000 + ((i * 53) % 200));
    expect(interval).toBe(getSettings().telemetryIntervalS);
    expect(stored).toBe(91);
    // Each fast report has a rate, so the live graph really moves every second.
    expect(fastRows).toBe(60);
  });
});
