import { createServer } from "node:net";
import nodemailer from "nodemailer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { startFakeSmtp } from "./fake-smtp";
import { makeServerCert } from "./test-certs";
import { AlertError, ALERT_RETRY_MS, checkGatewayAlerts, recipients, resetAlertClockForTests, sendTestEmail, setMailerForTests, smtpCategory, SmtpError, smtpView, updateSmtp } from "@/server/alerts";
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

  it("records a failed send and retries it after a pause instead of losing it", async () => {
    updateSmtp({ smtpHost: "smtp.example.com", smtpFrom: "m@example.com", alertTo: "it@example.com" });
    let attempts = 0;
    setMailerForTests(async (m) => {
      attempts++;
      if (attempts <= 2) throw new Error("relay refused");
      sent.push(m);
    });
    const site = createSite({ name: "DC" });
    const gw = enrol(site.id);
    ingestTelemetry(gw, telemetrySchema.parse({ peers: [] }));
    now += 120_000;
    expect((await checkGatewayAlerts(now)).sent).toEqual([]);
    expect(attempts).toBe(1);
    expect(listEvents().find((e) => e.kind === "alert")?.message).toContain("relay refused");
    expect(getSite(site.id)!.gateway!.alertState).not.toBe("down"); // still owed

    // Every 15 s tick in between leaves the mail server alone.
    now += ALERT_RETRY_MS / 2;
    expect((await checkGatewayAlerts(now)).sent).toEqual([]);
    expect(attempts).toBe(1);
    now += ALERT_RETRY_MS / 2;
    expect((await checkGatewayAlerts(now)).sent).toEqual([]);
    expect(attempts).toBe(2);
    // The pause doubles after a second failure.
    now += ALERT_RETRY_MS;
    expect((await checkGatewayAlerts(now)).sent).toEqual([]);
    expect(attempts).toBe(2);
    now += ALERT_RETRY_MS;
    expect((await checkGatewayAlerts(now)).sent).toEqual([{ siteId: site.id, kind: "down" }]);
    expect(sent).toHaveLength(1);
    expect(getSite(site.id)!.gateway!.alertState).toBe("down");
    now += ALERT_RETRY_MS;
    expect((await checkGatewayAlerts(now)).sent).toEqual([]);
    expect(attempts).toBe(3);
  });

  it("runs one pass at a time and never sends the same alert twice", async () => {
    updateSmtp({ smtpHost: "smtp.example.com", smtpFrom: "m@example.com", alertTo: "it@example.com" });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    setMailerForTests(async (m) => {
      sent.push(m);
      if (sent.length === 1) await held; // a slow mail server
    });
    const sites = [createSite({ name: "DC" }), createSite({ name: "Office" })];
    for (const site of sites) ingestTelemetry(enrol(site.id), telemetrySchema.parse({ peers: [] }));
    now += 120_000;
    const first = checkGatewayAlerts(now);
    expect(sent).toHaveLength(1); // the pass reaches the mailer without yielding
    const waiting = sites.find((s) => !sent[0]!.subject.includes(s.name))!;
    // Claimed before sending.
    expect(sites.map((s) => getSite(s.id)!.gateway!.alertState).sort()).toEqual(["", "down"]);
    // The next tick finds a pass still running and leaves the other site to it.
    now += 15_000;
    expect((await checkGatewayAlerts(now)).sent).toEqual([]);
    expect(sent).toHaveLength(1);
    release();
    expect((await first).sent.map((x) => x.siteId).sort()).toEqual(sites.map((s) => s.id).sort());
    expect(sent[1]!.subject).toContain(waiting.name);
    now += 15_000;
    expect((await checkGatewayAlerts(now)).sent).toEqual([]);
    expect(sent).toHaveLength(2);
  });
});

describe("the SMTP transport", () => {
  beforeEach(() => {
    setMailerForTests(undefined); // the real nodemailer transport
  });

  function configure(port: number) {
    updateSmtp({ smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false, smtpUser: "mesh", smtpPassword: "hunter2-secret", smtpFrom: "m@example.com", alertTo: "it@example.com" });
  }

  it("insists on STARTTLS, so a stripped offer never exposes the password, and bounds every wait", async () => {
    const smtp = await startFakeSmtp();
    const create = vi.spyOn(nodemailer, "createTransport");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      configure(smtp.port);
      const err = await sendTestEmail().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SmtpError);
      expect((err as Error).message).toMatch(/does not offer STARTTLS/);
      expect(smtp.lines).toContain("STARTTLS");
      expect(smtp.lines.some((l) => /^AUTH/i.test(l) || l.includes("hunter2"))).toBe(false);
      const options = create.mock.calls[0]![0] as Record<string, unknown>;
      expect(options).toMatchObject({ secure: false, requireTLS: true, tls: { rejectUnauthorized: true } });
      for (const k of ["connectionTimeout", "greetingTimeout", "socketTimeout"]) {
        expect(options[k]).toBeGreaterThanOrEqual(15_000);
        expect(options[k]).toBeLessThanOrEqual(30_000);
      }
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      await smtp.close();
    }
  });

  it("checks the certificate after STARTTLS and sends nothing to a server it cannot trust", async () => {
    const smtp = await startFakeSmtp({ startTls: makeServerCert(["127.0.0.1"]) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      configure(smtp.port);
      await expect(sendTestEmail()).rejects.toThrow(/certificate is not trusted/);
      expect(smtp.lines.filter((l) => l !== "STARTTLS" && !l.startsWith("EHLO"))).toEqual([]);
    } finally {
      await smtp.close();
    }
  });

  it("reports other services as a category and keeps their banner out of the answer", async () => {
    const ssh = await startFakeSmtp({ banner: "SSH-2.0-OpenSSH_9.6 internal-build-42\r\n" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      configure(ssh.port);
      const err = (await sendTestEmail().catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(SmtpError);
      expect(err.message).toBe("not an SMTP server");
      // The detail goes to the server log only, on one line.
      const line = String(log.mock.calls[0]![0]);
      expect(line).toContain("SSH-2.0-OpenSSH_9.6");
      expect(line).not.toMatch(/[\r\n]/);
    } finally {
      await ssh.close();
    }
    // A closed port.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise((r) => probe.close(r));
    configure(port);
    await expect(sendTestEmail()).rejects.toThrow(/^connection refused$/);
  });

  it("maps nodemailer's errors without the server's words", () => {
    const e = (props: Record<string, unknown>) => Object.assign(new Error(String(props.message ?? "x")), props);
    expect(smtpCategory(e({ code: "EAUTH", responseCode: 535, response: "535 5.7.8 user mesh@corp unknown", message: "Invalid login: 535 5.7.8 user mesh@corp unknown" }))).toBe("authentication failed (SMTP 535)");
    expect(smtpCategory(e({ code: "EDNS" }))).toBe("host not found");
    expect(smtpCategory(e({ code: "ETIMEDOUT" }))).toBe("timed out");
    expect(smtpCategory(e({ code: "EENVELOPE", responseCode: 550 }))).toBe("the mail server rejected the sender or a recipient (SMTP 550)");
    expect(smtpCategory(e({ code: "ECONNECTION", command: "EHLO", responseCode: 502 }))).toMatch(/does not offer STARTTLS/);
    // A reply that happens to mention certificates does not steer the category.
    expect(smtpCategory(e({ code: "ETLS", command: "CONN", response: "certificate expired", message: "Connection closed unexpectedly: certificate expired" }))).toBe("TLS handshake failed");
    expect(smtpCategory(e({ code: "ETLS", command: "STARTTLS", message: "Error initiating TLS - Hostname/IP does not match certificate's altnames" }))).toBe("the certificate does not match the host name");
    expect(smtpCategory(e({ code: "ESOCKET", message: "wrong version number", library: "SSL routines" }))).toBe("TLS handshake failed");
    expect(smtpCategory(e({ code: "EMESSAGE", responseCode: 552 }))).toBe("the mail server rejected the message (SMTP 552)");
    expect(smtpCategory(new Error("anything"))).toBe("sending failed");
  });
});
