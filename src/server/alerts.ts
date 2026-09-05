/**
 * Email alerts: a gateway that stops responding, and its recovery.
 *
 * SMTP settings live on the settings row (password sealed). A job checks
 * every gateway's health on a short interval and emails on the transition
 * to "offline" (once) and back to "online" (once), per site, when the site
 * has alerts switched on. A short grace after controller start avoids a
 * storm of "down" mails for gateways that simply have not reported yet.
 */
import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gateways, settings } from "@/db/schema";
import { open, seal } from "@/core/crypto";
import { env, now } from "./env";
import { logEvent } from "./events";
import { liveState } from "./live";
import { getSettings } from "./settings";
import { listSites } from "./sites";
import { gatewayHealth } from "./status";

export interface SmtpView {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPasswordSet: boolean;
  smtpFrom: string;
  alertTo: string;
  configured: boolean;
}

export class AlertError extends Error {}

export function smtpView(): SmtpView {
  const s = getSettings();
  return {
    smtpHost: s.smtpHost,
    smtpPort: s.smtpPort,
    smtpSecure: s.smtpSecure,
    smtpUser: s.smtpUser,
    smtpPasswordSet: s.smtpPassEnc !== "",
    smtpFrom: s.smtpFrom,
    alertTo: s.alertTo,
    configured: isConfigured(s),
  };
}

function isConfigured(s: { smtpHost: string; smtpFrom: string; alertTo: string }): boolean {
  return s.smtpHost !== "" && s.smtpFrom !== "" && s.alertTo.trim() !== "";
}

export interface SmtpPatch {
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  /** Empty string keeps the stored password; a value replaces it. */
  smtpPassword?: string;
  smtpFrom?: string;
  alertTo?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function recipients(list: string): string[] {
  return list
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function updateSmtp(patch: SmtpPatch, actor = "admin"): SmtpView {
  const s = getSettings();
  const next = {
    smtpHost: (patch.smtpHost ?? s.smtpHost).trim(),
    smtpPort: patch.smtpPort ?? s.smtpPort,
    smtpSecure: patch.smtpSecure ?? s.smtpSecure,
    smtpUser: (patch.smtpUser ?? s.smtpUser).trim(),
    smtpPassEnc: patch.smtpPassword ? seal(patch.smtpPassword, env().secret, "smtp") : s.smtpPassEnc,
    smtpFrom: (patch.smtpFrom ?? s.smtpFrom).trim(),
    alertTo: recipients(patch.alertTo ?? s.alertTo).join(", "),
  };
  if (next.smtpHost.length > 253 || /[\s/]/.test(next.smtpHost)) throw new AlertError("SMTP host is not valid");
  if (!Number.isInteger(next.smtpPort) || next.smtpPort < 1 || next.smtpPort > 65535) throw new AlertError("SMTP port is out of range");
  if (next.smtpFrom && !EMAIL_RE.test(next.smtpFrom.replace(/^.*<([^>]+)>$/, "$1"))) throw new AlertError("the from address is not a valid email address");
  for (const r of recipients(next.alertTo)) if (!EMAIL_RE.test(r)) throw new AlertError(`"${r}" is not a valid email address`);
  getDb().update(settings).set(next).where(eq(settings.id, 1)).run();
  logEvent("settings", "Email alert settings updated", { actor });
  return smtpView();
}

// ---------------------------------------------------------------------------
// Sending

export type Mailer = (mail: { to: string[]; subject: string; text: string }) => Promise<void>;

const g = globalThis as unknown as { __opnmeshMailer?: Mailer; __opnmeshStarted?: number };

/** Tests replace the transport. */
export function setMailerForTests(m: Mailer | undefined): void {
  g.__opnmeshMailer = m;
}

async function defaultMailer(mail: { to: string[]; subject: string; text: string }): Promise<void> {
  const s = getSettings();
  if (!isConfigured(s)) throw new AlertError("email is not configured: set the SMTP server, from address and recipients in Settings");
  const transport = nodemailer.createTransport({
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpSecure,
    auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPassEnc ? open(s.smtpPassEnc, env().secret, "smtp") : "" } : undefined,
    connectionTimeout: 15_000,
  });
  await transport.sendMail({ from: s.smtpFrom, to: mail.to.join(", "), subject: mail.subject, text: mail.text });
}

export async function sendMail(subject: string, text: string): Promise<void> {
  const to = recipients(getSettings().alertTo);
  if (to.length === 0) throw new AlertError("no alert recipients are set");
  await (g.__opnmeshMailer ?? defaultMailer)({ to, subject, text });
}

export async function sendTestEmail(actor = "admin"): Promise<string[]> {
  const to = recipients(getSettings().alertTo);
  const name = getSettings().networkName;
  await sendMail(`[${name}] OPNmesh test email`, `This is a test email from OPNmesh (${env().publicUrl}).\n\nIf you are reading it, alerts for gateways going down will reach this address.\n`);
  logEvent("alert", `Test email sent to ${to.join(", ")}`, { actor });
  return to;
}

// ---------------------------------------------------------------------------
// Gateway down / recovered

export const ALERT_GRACE_MS = 120_000;

export interface AlertOutcome {
  sent: Array<{ siteId: string; kind: "down" | "up" }>;
}

/**
 * Evaluate every alert-enabled site. Idempotent: a transition produces one
 * email, recorded on the gateway row so a controller restart cannot resend.
 */
export async function checkGatewayAlerts(at = now()): Promise<AlertOutcome> {
  const out: AlertOutcome = { sent: [] };
  const s = getSettings();
  if (!isConfigured(s)) return out;
  const started = g.__opnmeshStarted ?? (g.__opnmeshStarted = at);
  const inGrace = at - started < ALERT_GRACE_MS;
  const live = liveState();
  for (const site of listSites()) {
    const gw = site.gateway;
    if (!gw || gw.status !== "active" || !site.alertEmail) continue;
    const health = gatewayHealth(gw, live.get(gw.id), at, s.telemetryIntervalS);
    if (health === "offline" && gw.alertState !== "down" && gw.lastSeenAt !== null && !inGrace) {
      const since = live.get(gw.id)?.at ?? gw.lastSeenAt;
      await notify(site.id, "down", `[${s.networkName}] ${site.name} gateway is not responding`, [
        `The OPNmesh gateway at ${site.name} (${gw.hostname || gw.name}) has stopped reporting.`,
        ``,
        `Last report: ${new Date(since).toLocaleString()}`,
        `Tunnel address: ${gw.tunnelIp}`,
        `Site address: ${gw.lanIp}`,
        ``,
        `Other sites keep talking to each other; only traffic to and from ${site.name} is affected.`,
        `Dashboard: ${env().publicUrl}/sites/${site.id}`,
      ].join("\n"));
      getDb().update(gateways).set({ alertState: "down" }).where(eq(gateways.id, gw.id)).run();
      out.sent.push({ siteId: site.id, kind: "down" });
    } else if (health === "online" && gw.alertState === "down") {
      await notify(site.id, "up", `[${s.networkName}] ${site.name} gateway is back`, [
        `The OPNmesh gateway at ${site.name} (${gw.hostname || gw.name}) is reporting again.`,
        ``,
        `Dashboard: ${env().publicUrl}/sites/${site.id}`,
      ].join("\n"));
      getDb().update(gateways).set({ alertState: "up" }).where(eq(gateways.id, gw.id)).run();
      out.sent.push({ siteId: site.id, kind: "up" });
    }
  }
  return out;
}

async function notify(siteId: string, kind: "down" | "up", subject: string, text: string): Promise<void> {
  try {
    await sendMail(subject, text);
    logEvent("alert", `Email sent: ${subject}`, { subject: siteId, detail: { kind } });
  } catch (e) {
    logEvent("alert", `Email failed: ${subject} — ${e instanceof Error ? e.message : String(e)}`, { subject: siteId, detail: { kind } });
  }
}

/** Tests: reset the start-of-process grace. */
export function resetAlertClockForTests(at: number): void {
  g.__opnmeshStarted = at;
}
