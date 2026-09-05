import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { AlertError, checkGatewayAlerts, recipients, resetAlertClockForTests, sendTestEmail, setMailerForTests, smtpView, updateSmtp } from "@/server/alerts";
import { addLan, createEnrolToken, createSite, enrolGateway, getSite, updateSite } from "@/server/sites";
import { ingestTelemetry } from "@/server/telemetry";
import { telemetrySchema } from "@/server/live";
import { listEvents } from "@/server/events";
import { generateKeyPair } from "@/core/crypto";
import { getSettings } from "@/server/settings";

let now = 1_800_000_000_000;
const sent: Array<{ to: string[]; subject: string; text: string }> = [];

function enrol(siteId: string) {
  const { token } = createEnrolToken(siteId);
  const r = enrolGateway({ token, publicKey: generateKeyPair().publicKey, hostname: "gw", os: "", arch: "", addresses: ["10.0.250.2"], agentVersion: "" });
  if (!r.ok) throw new Error(r.reason);
  return getSite(siteId)!.gateway!;
}

beforeEach(() => {
  freshDb();
  sent.length = 0;
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  setMailerForTests(async (m) => {
    sent.push(m);
  });
  resetAlertClockForTests(now - 10 * 60_000); // well past the start-up grace
});
afterEach(() => {
  vi.restoreAllMocks();
  setMailerForTests(undefined);
});

describe("smtp settings", () => {
  it("validates and seals", () => {
    expect(smtpView().configured).toBe(false);
    updateSmtp({ smtpHost: "smtp.example.com", smtpPort: 587, smtpUser: "u", smtpPassword: "p", smtpFrom: "OPNmesh <mesh@example.com>", alertTo: "a@example.com; b@example.com" });
    const v = smtpView();
    expect(v.configured).toBe(true);
    expect(v.smtpPasswordSet).toBe(true);
    expect(v.alertTo).toBe("a@example.com, b@example.com");
    expect(getSettings().smtpPassEnc.startsWith("v1.")).toBe(true);
    updateSmtp({ smtpPassword: "" }); // empty keeps the stored one
    expect(smtpView().smtpPasswordSet).toBe(true);
    expect(() => updateSmtp({ alertTo: "not-an-address" })).toThrow(AlertError);
    expect(() => updateSmtp({ smtpPort: 70000 })).toThrow(AlertError);
    expect(() => updateSmtp({ smtpHost: "bad host" })).toThrow(AlertError);
    expect(recipients(" x@y.z ,, a@b.c\n")).toEqual(["x@y.z", "a@b.c"]);
  });
  it("sends a test email to every recipient", async () => {
    await expect(sendTestEmail()).rejects.toThrow(/not configured|no alert recipients/);
    updateSmtp({ smtpHost: "smtp.example.com", smtpFrom: "m@example.com", alertTo: "a@example.com, b@example.com" });
    const to = await sendTestEmail();
    expect(to).toEqual(["a@example.com", "b@example.com"]);
    expect(sent[0]!.subject).toContain("test email");
  });
});

describe("gateway down and recovery emails", () => {
  it("emails once on the transition to offline, once on recovery, and respects the per-site switch", async () => {
    updateSmtp({ smtpHost: "smtp.example.com", smtpFrom: "m@example.com", alertTo: "it@example.com" });
    const site = createSite({ name: "Datacentre" });
    addLan(site.id, { cidr: "10.0.1.0/24", name: "Servers" });
    const quiet = createSite({ name: "Quiet", alertEmail: false });
    const gw = enrol(site.id);
    const gwQuiet = enrol(quiet.id);
    const report = telemetrySchema.parse({ peers: [] });
    ingestTelemetry(gw, report);
    ingestTelemetry(gwQuiet, report);

    expect((await checkGatewayAlerts(now)).sent).toEqual([]);

    // 2 minutes of silence: offline (> 12 × 5 s).
    now += 120_000;
    const r1 = await checkGatewayAlerts(now);
    expect(r1.sent).toEqual([{ siteId: site.id, kind: "down" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("Datacentre gateway is not responding");
    expect(sent[0]!.text).toContain("10.0.250.2");
    expect(getSite(site.id)!.gateway!.alertState).toBe("down");

    // Still down: no repeat.
    now += 60_000;
    expect((await checkGatewayAlerts(now)).sent).toEqual([]);
    expect(sent).toHaveLength(1);

    // Back: one recovery email.
    ingestTelemetry(getSite(site.id)!.gateway!, report);
    const r3 = await checkGatewayAlerts(now);
    expect(r3.sent).toEqual([{ siteId: site.id, kind: "up" }]);
    expect(sent[1]!.subject).toContain("is back");
    expect(getSite(site.id)!.gateway!.alertState).toBe("up");
    expect(listEvents().filter((e) => e.kind === "alert")).toHaveLength(2);

    // Switching the site off silences it.
    updateSite(site.id, { alertEmail: false });
    now += 120_000;
    expect((await checkGatewayAlerts(now)).sent).toEqual([]);
  });

  it("does nothing during the start-up grace or without SMTP", async () => {
    const site = createSite({ name: "DC" });
    const gw = enrol(site.id);
    ingestTelemetry(gw, telemetrySchema.parse({ peers: [] }));
    now += 120_000;
    expect((await checkGatewayAlerts(now)).sent).toEqual([]); // not configured
    updateSmtp({ smtpHost: "smtp.example.com", smtpFrom: "m@example.com", alertTo: "it@example.com" });
    resetAlertClockForTests(now - 30_000); // controller started 30 s ago
    expect((await checkGatewayAlerts(now)).sent).toEqual([]);
    resetAlertClockForTests(now - 300_000);
    expect((await checkGatewayAlerts(now)).sent).toEqual([{ siteId: site.id, kind: "down" }]);
  });

  it("records a failed send in the event log and still marks the state", async () => {
    updateSmtp({ smtpHost: "smtp.example.com", smtpFrom: "m@example.com", alertTo: "it@example.com" });
    setMailerForTests(async () => {
      throw new Error("relay refused");
    });
    const site = createSite({ name: "DC" });
    const gw = enrol(site.id);
    ingestTelemetry(gw, telemetrySchema.parse({ peers: [] }));
    now += 120_000;
    await checkGatewayAlerts(now);
    expect(listEvents().find((e) => e.kind === "alert")?.message).toContain("relay refused");
  });
});
