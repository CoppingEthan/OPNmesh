/** Network settings (singleton row) and the config version counter. */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { settings, type SettingsRow } from "@/db/schema";
import { isValidCidr, cidrHasHostBits, cidrOverlaps, parseCidr } from "@/core/ip";
import { env } from "./env";
import { logEvent } from "./events";

export function getSettings(): SettingsRow {
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  if (!row) throw new Error("settings row missing — database not migrated");
  return row;
}

/** Increment the config version; call after any change that alters generated output. */
export function bumpConfigVersion(): number {
  const db = getDb();
  db.update(settings)
    .set({ configVersion: sql`${settings.configVersion} + 1` })
    .where(eq(settings.id, 1))
    .run();
  return getSettings().configVersion;
}

export interface SettingsPatch {
  networkName?: string;
  gatewayCidr?: string;
  clientCidr?: string;
  listenPort?: number;
  mtu?: number;
  keepalive?: number;
  interfaceName?: string;
  telemetryIntervalS?: number;
  publicUrl?: string | null;
}

export class SettingsError extends Error {}

/**
 * The address gateways and people are given for this controller: the
 * Settings override when one is set, otherwise OPNMESH_PUBLIC_URL. Used for
 * install commands, invite links and alert emails. The session cookie's
 * Secure flag follows the environment only, since that is what is served.
 */
export function publicUrl(): string {
  return getSettings().publicUrl || env().publicUrl;
}

/** Empty means "use the environment"; otherwise a bare https origin (http only in insecure/lab mode). */
export function normalisePublicUrl(value: string | null): string | null {
  const v = (value ?? "").trim();
  if (v === "") return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new SettingsError("public URL must be a full address such as https://mesh.example.com");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && env().insecureHttp)) throw new SettingsError("public URL must start with https://");
  if (u.pathname !== "/" || u.search !== "" || u.hash !== "" || u.username !== "" || u.password !== "") {
    throw new SettingsError("public URL is just the scheme, host and optional port, with no path");
  }
  return u.origin;
}

export function updateSettings(patch: SettingsPatch, actor = "admin"): SettingsRow {
  const current = getSettings();
  const next = { ...current, ...patch, publicUrl: patch.publicUrl === undefined ? current.publicUrl : normalisePublicUrl(patch.publicUrl) };
  for (const [label, cidr] of [
    ["gateway range", next.gatewayCidr],
    ["client range", next.clientCidr],
  ] as const) {
    if (!isValidCidr(cidr)) throw new SettingsError(`${label} "${cidr}" is not a valid network`);
    if (cidrHasHostBits(cidr)) throw new SettingsError(`${label} ${cidr} has host bits set`);
    const p = parseCidr(cidr)!.prefix;
    if (p > 29) throw new SettingsError(`${label} ${cidr} is too small — use /29 or larger`);
  }
  if (cidrOverlaps(next.gatewayCidr, next.clientCidr)) throw new SettingsError("gateway and client ranges overlap");
  if (next.listenPort < 1 || next.listenPort > 65535) throw new SettingsError("listen port out of range");
  if (next.mtu < 1280 || next.mtu > 1500) throw new SettingsError("MTU must be between 1280 and 1500");
  if (next.keepalive < 1 || next.keepalive > 3600) throw new SettingsError("keepalive must be 1–3600 seconds");
  if (!/^[a-z][a-z0-9_-]{0,14}$/.test(next.interfaceName)) throw new SettingsError("interface name must be 1–15 chars, lowercase");
  if (next.telemetryIntervalS < 2 || next.telemetryIntervalS > 60) throw new SettingsError("telemetry interval must be 2–60 seconds");

  const affectsConfig =
    next.gatewayCidr !== current.gatewayCidr ||
    next.clientCidr !== current.clientCidr ||
    next.listenPort !== current.listenPort ||
    next.mtu !== current.mtu ||
    next.keepalive !== current.keepalive ||
    next.interfaceName !== current.interfaceName;

  getDb()
    .update(settings)
    .set({
      networkName: next.networkName,
      gatewayCidr: next.gatewayCidr,
      clientCidr: next.clientCidr,
      listenPort: next.listenPort,
      mtu: next.mtu,
      keepalive: next.keepalive,
      interfaceName: next.interfaceName,
      telemetryIntervalS: next.telemetryIntervalS,
      publicUrl: next.publicUrl ?? null,
    })
    .where(eq(settings.id, 1))
    .run();
  if (affectsConfig) bumpConfigVersion();
  logEvent("settings", "Network settings updated", { actor, detail: patch });
  return getSettings();
}

export function markSetupComplete(): void {
  getDb().update(settings).set({ setupComplete: true }).where(eq(settings.id, 1)).run();
}
