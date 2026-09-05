/**
 * Versioned SQL migrations, applied in order at startup. The database's
 * `user_version` pragma records how many have run. Append; never edit a
 * shipped entry.
 */
export const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  network_name TEXT NOT NULL DEFAULT 'OPNmesh',
  gateway_cidr TEXT NOT NULL DEFAULT '10.99.0.0/24',
  client_cidr TEXT NOT NULL DEFAULT '10.99.1.0/24',
  listen_port INTEGER NOT NULL DEFAULT 51820,
  mtu INTEGER NOT NULL DEFAULT 1420,
  keepalive INTEGER NOT NULL DEFAULT 25,
  interface_name TEXT NOT NULL DEFAULT 'opnmesh0',
  telemetry_interval_s INTEGER NOT NULL DEFAULT 5,
  public_url TEXT,
  config_version INTEGER NOT NULL DEFAULT 1,
  setup_complete INTEGER NOT NULL DEFAULT 0
);
INSERT INTO settings (id) VALUES (1);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  notes TEXT NOT NULL DEFAULT '',
  router_layout TEXT NOT NULL DEFAULT 'transit',
  hub_priority INTEGER NOT NULL DEFAULT 100,
  dns_server TEXT,
  dns_domain TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE lans (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  cidr TEXT NOT NULL,
  name TEXT NOT NULL,
  vlan INTEGER,
  shared INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX lans_site ON lans(site_id);

CREATE TABLE gateways (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL UNIQUE REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL DEFAULT '',
  public_key TEXT NOT NULL UNIQUE,
  tunnel_ip TEXT NOT NULL UNIQUE,
  lan_ip TEXT NOT NULL,
  endpoint_host TEXT,
  listen_port INTEGER,
  mtu INTEGER,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  enrolled_at INTEGER NOT NULL,
  approved_at INTEGER,
  last_seen_at INTEGER,
  agent_version TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  addresses TEXT NOT NULL DEFAULT '[]',
  last_error TEXT NOT NULL DEFAULT '',
  applied_hash TEXT NOT NULL DEFAULT '',
  disk_hash TEXT NOT NULL DEFAULT ''
);

CREATE TABLE enrol_tokens (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  auto_approve INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  tunnel_ip TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL UNIQUE,
  private_key_enc TEXT NOT NULL,
  psk_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  preferred_site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
  allowed_site_ids TEXT,
  allow_inbound INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_handshake_at INTEGER
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE unifi_links (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL UNIQUE REFERENCES sites(id) ON DELETE CASCADE,
  base_url TEXT NOT NULL,
  unifi_site TEXT NOT NULL DEFAULT 'default',
  auth_kind TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  cert_fingerprint TEXT,
  managed_ids TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sync_at INTEGER,
  last_sync_status TEXT NOT NULL DEFAULT 'never',
  last_sync_detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE telemetry_5s (
  ts INTEGER NOT NULL,
  gateway_id TEXT NOT NULL,
  peer_key TEXT NOT NULL,
  rx_bytes INTEGER NOT NULL,
  tx_bytes INTEGER NOT NULL,
  rx_bps REAL NOT NULL,
  tx_bps REAL NOT NULL,
  handshake_age_s INTEGER,
  rtt_ms REAL,
  PRIMARY KEY (gateway_id, peer_key, ts)
) WITHOUT ROWID;
CREATE INDEX telemetry_5s_ts ON telemetry_5s(ts);

CREATE TABLE telemetry_1m (
  ts INTEGER NOT NULL, gateway_id TEXT NOT NULL, peer_key TEXT NOT NULL,
  rx_bps REAL NOT NULL, tx_bps REAL NOT NULL, rtt_ms REAL,
  PRIMARY KEY (gateway_id, peer_key, ts)
) WITHOUT ROWID;
CREATE INDEX telemetry_1m_ts ON telemetry_1m(ts);

CREATE TABLE telemetry_1h (
  ts INTEGER NOT NULL, gateway_id TEXT NOT NULL, peer_key TEXT NOT NULL,
  rx_bps REAL NOT NULL, tx_bps REAL NOT NULL, rtt_ms REAL,
  PRIMARY KEY (gateway_id, peer_key, ts)
) WITHOUT ROWID;
CREATE INDEX telemetry_1h_ts ON telemetry_1h(ts);

CREATE TABLE pair_5s (
  ts INTEGER NOT NULL, gateway_id TEXT NOT NULL, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL,
  bytes INTEGER NOT NULL, bps REAL NOT NULL,
  PRIMARY KEY (gateway_id, from_slug, to_slug, ts)
) WITHOUT ROWID;
CREATE INDEX pair_5s_ts ON pair_5s(ts);

CREATE TABLE pair_1m (
  ts INTEGER NOT NULL, gateway_id TEXT NOT NULL, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL,
  bps REAL NOT NULL,
  PRIMARY KEY (gateway_id, from_slug, to_slug, ts)
) WITHOUT ROWID;
CREATE INDEX pair_1m_ts ON pair_1m(ts);

CREATE TABLE pair_1h (
  ts INTEGER NOT NULL, gateway_id TEXT NOT NULL, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL,
  bps REAL NOT NULL,
  PRIMARY KEY (gateway_id, from_slug, to_slug, ts)
) WITHOUT ROWID;
CREATE INDEX pair_1h_ts ON pair_1h(ts);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX events_ts ON events(ts);
`,
  // 2 — email alerts: SMTP settings, per-site toggle, last notified state
  `
ALTER TABLE settings ADD COLUMN smtp_host TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN smtp_port INTEGER NOT NULL DEFAULT 587;
ALTER TABLE settings ADD COLUMN smtp_secure INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN smtp_user TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN smtp_pass_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN smtp_from TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN alert_to TEXT NOT NULL DEFAULT '';
ALTER TABLE sites ADD COLUMN alert_email INTEGER NOT NULL DEFAULT 1;
ALTER TABLE gateways ADD COLUMN alert_state TEXT NOT NULL DEFAULT '';
`,
  // 3 — health checks: when a run was requested, when the gateway answered, its report
  `
ALTER TABLE gateways ADD COLUMN diag_requested_at INTEGER;
ALTER TABLE gateways ADD COLUMN diag_at INTEGER;
ALTER TABLE gateways ADD COLUMN diag_json TEXT;
`,
];
