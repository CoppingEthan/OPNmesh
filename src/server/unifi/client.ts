/**
 * A small client for a UniFi Network console's local APIs.
 *
 * Two API families are used (see docs/ROUTERS.md §4):
 *  - the classic API  /proxy/network/api/s/{site}/rest/...   (static routes,
 *    networks, port forwards) — the only place static routes exist;
 *  - the v2 API       /proxy/network/v2/api/site/{site}/...  (zone firewall).
 *
 * Authentication is an API key (X-API-KEY, UniFi OS consoles) or a local
 * admin login (cookie + X-CSRF-Token, standalone Network application).
 *
 * TLS: consoles ship a self-signed certificate. Certificate checking is never
 * switched off. On first contact the console's leaf certificate is fetched
 * and shown to the admin as a fingerprint; once confirmed it is pinned and
 * used as the trust anchor for every later connection.
 */
import { X509Certificate } from "node:crypto";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { URL } from "node:url";

export type UnifiAuth = { kind: "api_key"; apiKey: string } | { kind: "password"; username: string; password: string };

export interface UnifiClientConfig {
  baseUrl: string;
  site: string;
  auth: UnifiAuth;
  /** Pinned leaf certificate (PEM) and its SHA-256 fingerprint; null before confirmation. */
  pin: { fingerprint: string; pem: string } | null;
  /** Standalone Network application (no /proxy/network prefix, /api/login). */
  standalone?: boolean;
  timeoutMs?: number;
}

export interface ConsoleCertificate {
  fingerprint: string;
  pem: string;
  subject: string;
  issuer: string;
  validTo: string;
  systemTrusted: boolean;
}

export class UnifiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
  ) {
    super(message);
  }
}

export interface UnifiRoute {
  _id?: string;
  name: string;
  enabled: boolean;
  type: "static-route";
  "static-route_network": string;
  "static-route_type": "nexthop-route" | "interface-route" | "blackhole";
  "static-route_nexthop"?: string;
  "static-route_interface"?: string;
  "static-route_distance": number;
  gateway_type?: string;
  gateway_device?: string;
  site_id?: string;
}

export interface UnifiNetwork {
  _id: string;
  name: string;
  purpose?: string;
  vlan?: number;
  ip_subnet?: string;
  enabled?: boolean;
}

export interface UnifiPortForward {
  _id?: string;
  name: string;
  enabled: boolean;
  proto: string;
  dst_port: string;
  fwd: string;
  fwd_port: string;
  src?: string;
}

export interface UnifiZone {
  _id: string;
  name: string;
  network_ids?: string[];
  default_zone?: boolean;
}

export interface UnifiFirewallPolicy {
  _id?: string;
  name: string;
  enabled: boolean;
  action: "ALLOW" | "BLOCK" | "REJECT";
  predefined?: boolean;
  index?: number;
  protocol?: string;
  ip_version?: "IPV4" | "IPV6" | "BOTH";
  connection_state_type?: "ALL" | "CUSTOM" | "RESPOND_ONLY";
  connection_states?: string[];
  logging?: boolean;
  schedule?: { mode: string };
  source: { zone_id: string; matching_target?: string; network_ids?: string[]; ips?: string[]; port_matching_type?: string };
  destination: { zone_id: string; matching_target?: string; network_ids?: string[]; ips?: string[]; port_matching_type?: string };
}

/** Fetch the console's certificate without trusting it, for the admin to confirm. */
export async function fetchConsoleCertificate(baseUrl: string, timeoutMs = 10_000): Promise<ConsoleCertificate> {
  const u = new URL(baseUrl);
  if (u.protocol !== "https:") throw new UnifiError("console URL must start with https://");
  const port = Number(u.port || 443);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      try {
        const cert = sock.getPeerCertificate(false);
        if (!cert || !cert.raw) throw new UnifiError("console presented no certificate");
        const pem = `-----BEGIN CERTIFICATE-----\n${cert.raw.toString("base64").replace(/(.{64})/g, "$1\n").trim()}\n-----END CERTIFICATE-----\n`;
        const x = new X509Certificate(pem);
        resolve({
          fingerprint: x.fingerprint256.toLowerCase(),
          pem,
          subject: x.subject.replace(/\n/g, ", "),
          issuer: x.issuer.replace(/\n/g, ", "),
          validTo: x.validTo,
          systemTrusted: sock.authorized,
        });
      } catch (e) {
        reject(e);
      } finally {
        sock.end();
      }
    });
    sock.on("timeout", () => {
      sock.destroy();
      reject(new UnifiError("timed out connecting to the console"));
    });
    sock.on("error", (e) => reject(new UnifiError(`cannot connect to the console: ${e.message}`)));
  });
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export class UnifiClient {
  private cookie = "";
  private csrf = "";
  private agent: https.Agent | http.Agent;
  private readonly base: URL;
  private readonly timeout: number;

  constructor(private readonly cfg: UnifiClientConfig) {
    this.base = new URL(cfg.baseUrl);
    this.timeout = cfg.timeoutMs ?? 15_000;
    if (this.base.protocol === "http:") {
      // Only for the fake console in tests; a real console is always https.
      this.agent = new http.Agent({ keepAlive: true });
    } else if (cfg.pin) {
      const pin = cfg.pin;
      this.agent = new https.Agent({
        keepAlive: true,
        ca: [pin.pem],
        // The pinned certificate is the trust anchor; the hostname is not
        // checked because consoles are reached by IP or a private name.
        checkServerIdentity: (_host, cert) => (cert.fingerprint256.toLowerCase() === pin.fingerprint ? undefined : new Error("console certificate does not match the pinned fingerprint")),
      });
    } else {
      // No pin yet: system trust only (a console with a real certificate).
      this.agent = new https.Agent({ keepAlive: true });
    }
  }

  private prefix(): string {
    return this.cfg.standalone ? "" : "/proxy/network";
  }

  private async raw(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const url = new URL(path, this.base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: "application/json", ...extraHeaders };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    if (this.cfg.auth.kind === "api_key") headers["X-API-KEY"] = this.cfg.auth.apiKey;
    if (this.cookie) headers["Cookie"] = this.cookie;
    if (this.csrf && method !== "GET") headers["X-CSRF-Token"] = this.csrf;
    const mod = url.protocol === "http:" ? http : https;
    return new Promise((resolve, reject) => {
      const req = mod.request(url, { method, headers, agent: this.agent, timeout: this.timeout }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => {
        req.destroy(new UnifiError("request to the console timed out"));
      });
      req.on("error", (e) => reject(e instanceof UnifiError ? e : new UnifiError(`console request failed: ${e.message}`)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /** Log in when using a local account; a no-op with an API key. */
  async login(): Promise<void> {
    if (this.cfg.auth.kind !== "password") return;
    const path = this.cfg.standalone ? "/api/login" : "/api/auth/login";
    const res = await this.raw("POST", path, { username: this.cfg.auth.username, password: this.cfg.auth.password, remember: false });
    if (res.status !== 200) throw new UnifiError(`login failed (${res.status}): ${summarise(res.body)}`, res.status);
    const setCookie = res.headers["set-cookie"] ?? [];
    this.cookie = setCookie.map((c) => c.split(";")[0]!).join("; ");
    const csrf = res.headers["x-csrf-token"];
    this.csrf = Array.isArray(csrf) ? (csrf[0] ?? "") : (csrf ?? "");
    if (!this.csrf) {
      const m = /TOKEN=([^;]+)/.exec(this.cookie);
      if (m) this.csrf = decodeCsrfFromJwt(m[1]!) ?? "";
    }
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res = await this.raw(method, path, body);
    if (res.status === 401 && this.cfg.auth.kind === "password") {
      await this.login();
      res = await this.raw(method, path, body);
    }
    if (res.status === 401 || res.status === 403) throw new UnifiError(`the console refused the credentials (${res.status})`, res.status);
    if (res.status >= 400) throw new UnifiError(`console returned ${res.status} for ${method} ${path}: ${summarise(res.body)}`, res.status);
    if (!res.body) return undefined as T;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new UnifiError(`console returned something that is not JSON for ${method} ${path}`);
    }
  }

  /** Classic API responses wrap data in { meta: { rc }, data: [...] }. */
  private async classic<T>(method: string, path: string, body?: unknown): Promise<T[]> {
    const out = await this.json<{ meta?: { rc?: string; msg?: string }; data?: T[] }>(method, `${this.prefix()}/api/s/${encodeURIComponent(this.cfg.site)}/${path}`, body);
    if (out && out.meta && out.meta.rc && out.meta.rc !== "ok") throw new UnifiError(`console error: ${out.meta.msg ?? out.meta.rc}`);
    return out?.data ?? [];
  }

  private v2(path: string): string {
    return `${this.prefix()}/v2/api/site/${encodeURIComponent(this.cfg.site)}/${path}`;
  }

  // --- probes ---------------------------------------------------------------

  async whoami(): Promise<{ name?: string; version?: string }> {
    const self = await this.classic<{ name?: string }>("GET", "self");
    let version: string | undefined;
    try {
      const st = await this.json<{ meta?: { server_version?: string } }>("GET", `${this.prefix()}/status`);
      version = st?.meta?.server_version;
    } catch {
      /* optional */
    }
    return { name: self[0]?.name, version };
  }

  // --- classic: routes, networks, port forwards ----------------------------

  listRoutes(): Promise<UnifiRoute[]> {
    return this.classic<UnifiRoute>("GET", "rest/routing");
  }
  async createRoute(r: UnifiRoute): Promise<UnifiRoute> {
    const out = await this.classic<UnifiRoute>("POST", "rest/routing", r);
    const created = out[0];
    if (!created) throw new UnifiError("console did not return the created route");
    return created;
  }
  async updateRoute(id: string, r: UnifiRoute): Promise<UnifiRoute> {
    const out = await this.classic<UnifiRoute>("PUT", `rest/routing/${encodeURIComponent(id)}`, { ...r, _id: id });
    return out[0] ?? { ...r, _id: id };
  }
  async deleteRoute(id: string): Promise<void> {
    await this.classic("DELETE", `rest/routing/${encodeURIComponent(id)}`);
  }
  listNetworks(): Promise<UnifiNetwork[]> {
    return this.classic<UnifiNetwork>("GET", "rest/networkconf");
  }
  listPortForwards(): Promise<UnifiPortForward[]> {
    return this.classic<UnifiPortForward>("GET", "rest/portforward");
  }

  // --- v2: zone-based firewall ----------------------------------------------

  listZones(): Promise<UnifiZone[]> {
    return this.json<UnifiZone[]>("GET", this.v2("firewall/zones"));
  }
  listFirewallPolicies(): Promise<UnifiFirewallPolicy[]> {
    return this.json<UnifiFirewallPolicy[]>("GET", this.v2("firewall-policies"));
  }
  createFirewallPolicy(p: UnifiFirewallPolicy): Promise<UnifiFirewallPolicy> {
    return this.json<UnifiFirewallPolicy>("POST", this.v2("firewall-policies"), p);
  }
  updateFirewallPolicy(id: string, p: UnifiFirewallPolicy): Promise<UnifiFirewallPolicy> {
    return this.json<UnifiFirewallPolicy>("PUT", this.v2(`firewall-policies/${encodeURIComponent(id)}`), { ...p, _id: id });
  }
  async deleteFirewallPolicy(id: string): Promise<void> {
    await this.json("DELETE", this.v2(`firewall-policies/${encodeURIComponent(id)}`));
  }
}

function summarise(body: string): string {
  const t = body.replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 160) + "…" : t;
}

function decodeCsrfFromJwt(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { csrfToken?: string };
    return json.csrfToken ?? null;
  } catch {
    return null;
  }
}
