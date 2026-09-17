/**
 * Email alerts: a gateway that stops responding, and its recovery.
 *
 * SMTP settings live on the settings row (password sealed). A job checks
 * every gateway's health on a short interval and emails on the transition
 * to "offline" (once) and back to "online" (once), per site, when the site
 * has alerts switched on. A short grace after controller start avoids a
 * storm of "down" mails for gateways that simply have not reported yet.
 *
 * Mail server errors are reported as a category, never as the server's own
 * words, so the test button cannot be used to read banners off other
 * services; the full error goes to the server log.
 */
import { getSystemErrorName } from "node:util";
import nodemailer from "nodemailer";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gateways, settings } from "@/db/schema";
import { open, seal } from "@/core/crypto";
import { env, now } from "./env";
import { logEvent } from "./events";
import { liveState } from "./live";
import { getSettings, publicUrl } from "./settings";
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

/** The mail server could not be reached or refused the message; the message is a category. */
export class SmtpError extends Error {}

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

const g = globalThis as unknown as { __opnmeshMailer?: Mailer; __opnmeshStarted?: number; __opnmeshAlertsRunning?: boolean; __opnmeshAlertRetry?: { at: number; failures: number } };

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
    // Without TLS from the first byte, insist on STARTTLS: an on-path attacker
    // could otherwise strip it and read the password.
    requireTLS: !s.smtpSecure,
    tls: { rejectUnauthorized: true },
    auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPassEnc ? open(s.smtpPassEnc, env().secret, "smtp") : "" } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    // nodemailer's default is ten minutes of silence.
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({ from: s.smtpFrom, to: mail.to.join(", "), subject: mail.subject, text: mail.text });
  } catch (e) {
    console.error(`[opnmesh] sending email via ${s.smtpHost}:${s.smtpPort} failed: ${smtpDetail(e)}`.replace(/\p{Cc}+/gu, " ").slice(0, 1000));
    throw new SmtpError(smtpCategory(e));
  } finally {
    transport.close();
  }
}

type NodemailerError = { code?: unknown; command?: unknown; response?: unknown; responseCode?: unknown; errno?: unknown; library?: unknown; message?: unknown };

function smtpDetail(e: unknown): string {
  const err = (e ?? {}) as NodemailerError;
  return `${String(err.code ?? "")} ${String(err.command ?? "")}: ${String(err.message ?? e)}`;
}

/** Locally generated TLS error text, sorted into what an admin can act on. */
function tlsCategory(text: string): string {
  if (/altname|does not match|Hostname\/IP/i.test(text)) return "the certificate does not match the host name";
  if (/expired/i.test(text)) return "the certificate has expired";
  if (/self[- ]signed|unable to (get|verify)|certificate/i.test(text)) return "the certificate is not trusted";
  return "TLS handshake failed";
}

/** What went wrong, without any text the mail server sent. */
export function smtpCategory(e: unknown): string {
  const err = (e ?? {}) as NodemailerError;
  const code = typeof err.responseCode === "number" ? ` (SMTP ${err.responseCode})` : "";
  // Only matched against, never shown, and without the server's reply that nodemailer appends.
  const message = typeof err.message === "string" ? err.message : "";
  const reply = typeof err.response === "string" ? `: ${err.response}` : "";
  const text = reply && message.endsWith(reply) ? message.slice(0, -reply.length) : message;
  const noStartTls = "the server does not offer STARTTLS; use port 465 with TLS, or a server that supports STARTTLS";
  switch (err.code) {
    case "EDNS":
      return "host not found";
    case "ETIMEDOUT":
      return "timed out";
    case "EAUTH":
    case "ENOAUTH":
      return `authentication failed${code}`;
    case "ETLS":
      return err.command === "STARTTLS" && code ? noStartTls : tlsCategory(text);
    case "EPROTOCOL":
      return err.command === "CONN" ? "not an SMTP server" : `unexpected response from the mail server${code}`;
    case "EENVELOPE":
      return `the mail server rejected the sender or a recipient${code}`;
    case "EMESSAGE":
      return `the mail server rejected the message${code}`;
    case "ECONNECTION":
      if (err.command === "EHLO" && err.responseCode !== 421) return noStartTls;
      return `the mail server closed the connection${code}`;
    case "ESOCKET": {
      let name = "";
      try {
        name = typeof err.errno === "number" ? getSystemErrorName(err.errno) : "";
      } catch {
        /* not a system error number */
      }
      if (name === "ECONNREFUSED") return "connection refused";
      if (name === "ECONNRESET") return "connection reset";
      if (name === "EHOSTUNREACH" || name === "ENETUNREACH") return "host unreachable";
      if (name === "ETIMEDOUT") return "timed out";
      // OpenSSL errors name their library; certificate errors only say so in words.
      return typeof err.library === "string" || /SSL|TLS|certificate|altnames/i.test(text) ? tlsCategory(text) : "connection failed";
    }
  }
  return code ? `the mail server refused the message${code}` : "sending failed";
}

export async function sendMail(subject: string, text: string): Promise<void> {
  const to = recipients(getSettings().alertTo);
  if (to.length === 0) throw new AlertError("no alert recipients are set");
  await (g.__opnmeshMailer ?? defaultMailer)({ to, subject, text });
}

/** Throws AlertError when email is not set up, SmtpError when the server fails. */
export async function sendTestEmail(actor = "admin"): Promise<string[]> {
  const to = recipients(getSettings().alertTo);
  const name = getSettings().networkName;
  await sendMail(`[${name}] OPNmesh test email`, `This is a test email from OPNmesh (${publicUrl()}).\n\nIf you are reading it, alerts for gateways going down will reach this address.\n`);
  logEvent("alert", `Test email sent to ${to.join(", ")}`, { actor });
  // Mail works again: pending alerts need not wait out the retry pause.
  g.__opnmeshAlertRetry = undefined;
  return to;
}

// ---------------------------------------------------------------------------
// Gateway down / recovered

export const ALERT_GRACE_MS = 120_000;
/** After a failed send, wait this long before trying again, doubling up to an hour. */
export const ALERT_RETRY_MS = 60_000;
const ALERT_RETRY_MAX_MS = 60 * 60_000;

export interface AlertOutcome {
  sent: Array<{ siteId: string; kind: "down" | "up" }>;
}

/**
 * Evaluate every alert-enabled site. Idempotent: a transition produces one
 * email, recorded on the gateway row before sending so neither an overlapping
 * pass nor a controller restart can resend it. A failed send puts the state
 * back and the alert is retried after a pause.
 */
export async function checkGatewayAlerts(at = now()): Promise<AlertOutcome> {
  const out: AlertOutcome = { sent: [] };
  // One pass at a time: a slow mail server must not let the next tick start another.
  if (g.__opnmeshAlertsRunning) return out;
  g.__opnmeshAlertsRunning = true;
  try {
    await evaluateAlerts(at, out);
  } finally {
    g.__opnmeshAlertsRunning = false;
  }
  return out;
}

async function evaluateAlerts(at: number, out: AlertOutcome): Promise<void> {
  const s = getSettings();
  if (!isConfigured(s)) return;
  const started = g.__opnmeshStarted ?? (g.__opnmeshStarted = at);
  const inGrace = at - started < ALERT_GRACE_MS;
  // The mail server failed recently; pending alerts wait for the retry.
  if (g.__opnmeshAlertRetry && at < g.__opnmeshAlertRetry.at) return;
  const live = liveState();
  for (const site of listSites()) {
    const gw = site.gateway;
    if (!gw || gw.status !== "active" || !site.alertEmail) continue;
    const health = gatewayHealth(gw, live.get(gw.id), at, s.telemetryIntervalS);
    let kind: "down" | "up" | null = null;
    let subject = "";
    let text = "";
    if (health === "offline" && gw.alertState !== "down" && gw.lastSeenAt !== null && !inGrace) {
      const since = live.get(gw.id)?.at ?? gw.lastSeenAt;
      kind = "down";
      subject = `[${s.networkName}] ${site.name} gateway is not responding`;
      text = [
        `The OPNmesh gateway at ${site.name} (${gw.hostname || gw.name}) has stopped reporting.`,
        ``,
        `Last report: ${new Date(since).toLocaleString()}`,
        `Tunnel address: ${gw.tunnelIp}`,
        `Site address: ${gw.lanIp}`,
        ``,
        `Other sites keep talking to each other; only traffic to and from ${site.name} is affected.`,
        `Dashboard: ${publicUrl()}/sites/${site.id}`,
      ].join("\n");
    } else if (health === "online" && gw.alertState === "down") {
      kind = "up";
      subject = `[${s.networkName}] ${site.name} gateway is back`;
      text = [
        `The OPNmesh gateway at ${site.name} (${gw.hostname || gw.name}) is reporting again.`,
        ``,
        `Dashboard: ${publicUrl()}/sites/${site.id}`,
      ].join("\n");
    }
    if (!kind) continue;
    // Claim the transition first; zero rows means someone else already did.
    const claimed = getDb()
      .update(gateways)
      .set({ alertState: kind })
      .where(and(eq(gateways.id, gw.id), eq(gateways.alertState, gw.alertState)))
      .run().changes;
    if (claimed === 0) continue;
    if (await notify(site.id, kind, subject, text)) {
      out.sent.push({ siteId: site.id, kind });
      continue;
    }
    // Not delivered: put the state back (unless it moved on) so a later pass sends it.
    getDb()
      .update(gateways)
      .set({ alertState: gw.alertState })
      .where(and(eq(gateways.id, gw.id), eq(gateways.alertState, kind)))
      .run();
    const failures = (g.__opnmeshAlertRetry?.failures ?? 0) + 1;
    g.__opnmeshAlertRetry = { at: at + Math.min(ALERT_RETRY_MAX_MS, ALERT_RETRY_MS * 2 ** (failures - 1)), failures };
    return;
  }
}

async function notify(siteId: string, kind: "down" | "up", subject: string, text: string): Promise<boolean> {
  try {
    await sendMail(subject, text);
    g.__opnmeshAlertRetry = undefined;
    logEvent("alert", `Email sent: ${subject}`, { subject: siteId, detail: { kind } });
    return true;
  } catch (e) {
    logEvent("alert", `Email failed, will retry: ${subject} — ${e instanceof Error ? e.message : String(e)}`, { subject: siteId, detail: { kind } });
    return false;
  }
}

/** Tests: reset the start-of-process grace and any pending retry. */
export function resetAlertClockForTests(at: number): void {
  g.__opnmeshStarted = at;
  g.__opnmeshAlertRetry = undefined;
  g.__opnmeshAlertsRunning = false;
}
