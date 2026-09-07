/**
 * Drizzle schema — the typed view of the SQLite database. The SQL that creates
 * these tables lives in migrations.ts and is applied by the versioned migrator
 * at startup; keep the two in step (test/server/repos.test.ts and the API
 * tests exercise every table through this schema, so drift fails loudly).
 *
 * Timestamps are integer milliseconds since the epoch. JSON columns are text.
 */
import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  networkName: text("network_name").notNull(),
  gatewayCidr: text("gateway_cidr").notNull(),
  clientCidr: text("client_cidr").notNull(),
  listenPort: integer("listen_port").notNull(),
  mtu: integer("mtu").notNull(),
  keepalive: integer("keepalive").notNull(),
  interfaceName: text("interface_name").notNull(),
  telemetryIntervalS: integer("telemetry_interval_s").notNull(),
  publicUrl: text("public_url"),
  configVersion: integer("config_version").notNull(),
  setupComplete: integer("setup_complete", { mode: "boolean" }).notNull(),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull(),
  smtpSecure: integer("smtp_secure", { mode: "boolean" }).notNull(),
  smtpUser: text("smtp_user").notNull(),
  smtpPassEnc: text("smtp_pass_enc").notNull(),
  smtpFrom: text("smtp_from").notNull(),
  /** Comma-separated alert recipients. */
  alertTo: text("alert_to").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  notes: text("notes").notNull(),
  routerLayout: text("router_layout").$type<"transit" | "same_lan" | "masquerade">().notNull(),
  hubPriority: integer("hub_priority").notNull(),
  dnsServer: text("dns_server"),
  dnsDomain: text("dns_domain"),
  createdAt: integer("created_at").notNull(),
  /** Email when this site's gateway stops responding. */
  alertEmail: integer("alert_email", { mode: "boolean" }).notNull(),
});

export const lans = sqliteTable("lans", {
  id: text("id").primaryKey(),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  cidr: text("cidr").notNull(),
  name: text("name").notNull(),
  vlan: integer("vlan"),
  shared: integer("shared", { mode: "boolean" }).notNull(),
  sort: integer("sort").notNull(),
});

export type GatewayStatus = "pending" | "active" | "disabled";

export const gateways = sqliteTable("gateways", {
  id: text("id").primaryKey(),
  siteId: text("site_id")
    .notNull()
    .unique()
    .references(() => sites.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hostname: text("hostname").notNull(),
  publicKey: text("public_key").notNull().unique(),
  tunnelIp: text("tunnel_ip").notNull().unique(),
  lanIp: text("lan_ip").notNull(),
  endpointHost: text("endpoint_host"),
  listenPort: integer("listen_port"),
  mtu: integer("mtu"),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").$type<GatewayStatus>().notNull(),
  enrolledAt: integer("enrolled_at").notNull(),
  approvedAt: integer("approved_at"),
  lastSeenAt: integer("last_seen_at"),
  agentVersion: text("agent_version").notNull(),
  os: text("os").notNull(),
  arch: text("arch").notNull(),
  addresses: text("addresses", { mode: "json" }).$type<string[]>().notNull(),
  lastError: text("last_error").notNull(),
  appliedHash: text("applied_hash").notNull(),
  diskHash: text("disk_hash").notNull(),
  /** Last state an alert email was sent for: '' | 'down' | 'up'. */
  alertState: text("alert_state").notNull(),
  /** Health checks: when a run was last asked for, when the gateway answered, and its report (JSON). */
  diagRequestedAt: integer("diag_requested_at"),
  diagAt: integer("diag_at"),
  diagJson: text("diag_json"),
});

export const enrolTokens = sqliteTable("enrol_tokens", {
  id: text("id").primaryKey(),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  autoApprove: integer("auto_approve", { mode: "boolean" }).notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const clients = sqliteTable("clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  owner: text("owner").notNull(),
  notes: text("notes").notNull(),
  tunnelIp: text("tunnel_ip").notNull().unique(),
  publicKey: text("public_key").notNull().unique(),
  privateKeyEnc: text("private_key_enc").notNull(),
  pskEnc: text("psk_enc"),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  expiresAt: integer("expires_at"),
  preferredSiteId: text("preferred_site_id").references(() => sites.id, { onDelete: "set null" }),
  allowedSiteIds: text("allowed_site_ids", { mode: "json" }).$type<string[] | null>(),
  allowInbound: integer("allow_inbound", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at").notNull(),
  lastHandshakeAt: integer("last_handshake_at"),
});

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: integer("created_at").notNull(),
});

export const unifiLinks = sqliteTable("unifi_links", {
  id: text("id").primaryKey(),
  siteId: text("site_id")
    .notNull()
    .unique()
    .references(() => sites.id, { onDelete: "cascade" }),
  baseUrl: text("base_url").notNull(),
  unifiSite: text("unifi_site").notNull(),
  authKind: text("auth_kind").$type<"api_key" | "password">().notNull(),
  secretEnc: text("secret_enc").notNull(),
  certFingerprint: text("cert_fingerprint"),
  managedIds: text("managed_ids", { mode: "json" }).$type<{ routes: Record<string, string>; policy?: string }>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  lastSyncAt: integer("last_sync_at"),
  lastSyncStatus: text("last_sync_status").notNull(),
  lastSyncDetail: text("last_sync_detail").notNull(),
});

export const telemetry5s = sqliteTable(
  "telemetry_5s",
  {
    ts: integer("ts").notNull(),
    gatewayId: text("gateway_id").notNull(),
    peerKey: text("peer_key").notNull(),
    rxBytes: integer("rx_bytes").notNull(),
    txBytes: integer("tx_bytes").notNull(),
    rxBps: real("rx_bps").notNull(),
    txBps: real("tx_bps").notNull(),
    handshakeAgeS: integer("handshake_age_s"),
    rttMs: real("rtt_ms"),
  },
  (t) => [primaryKey({ columns: [t.gatewayId, t.peerKey, t.ts] })],
);

const rollupColumns = {
  ts: integer("ts").notNull(),
  gatewayId: text("gateway_id").notNull(),
  peerKey: text("peer_key").notNull(),
  rxBps: real("rx_bps").notNull(),
  txBps: real("tx_bps").notNull(),
  rttMs: real("rtt_ms"),
};
export const telemetry1m = sqliteTable("telemetry_1m", rollupColumns, (t) => [
  primaryKey({ columns: [t.gatewayId, t.peerKey, t.ts] }),
]);
export const telemetry1h = sqliteTable("telemetry_1h", rollupColumns, (t) => [
  primaryKey({ columns: [t.gatewayId, t.peerKey, t.ts] }),
]);

export const pair5s = sqliteTable(
  "pair_5s",
  {
    ts: integer("ts").notNull(),
    gatewayId: text("gateway_id").notNull(),
    fromSlug: text("from_slug").notNull(),
    toSlug: text("to_slug").notNull(),
    bytes: integer("bytes").notNull(),
    bps: real("bps").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gatewayId, t.fromSlug, t.toSlug, t.ts] })],
);
const pairRollup = {
  ts: integer("ts").notNull(),
  gatewayId: text("gateway_id").notNull(),
  fromSlug: text("from_slug").notNull(),
  toSlug: text("to_slug").notNull(),
  bps: real("bps").notNull(),
};
export const pair1m = sqliteTable("pair_1m", pairRollup, (t) => [
  primaryKey({ columns: [t.gatewayId, t.fromSlug, t.toSlug, t.ts] }),
]);
export const pair1h = sqliteTable("pair_1h", pairRollup, (t) => [
  primaryKey({ columns: [t.gatewayId, t.fromSlug, t.toSlug, t.ts] }),
]);

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),
  actor: text("actor").notNull(),
  kind: text("kind").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  detail: text("detail"),
});

export type SiteRow = typeof sites.$inferSelect;
export type LanRow = typeof lans.$inferSelect;
export type GatewayRow = typeof gateways.$inferSelect;
export type ClientRow = typeof clients.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type UnifiLinkRow = typeof unifiLinks.$inferSelect;
