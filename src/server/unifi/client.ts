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
 * used as the trust anchor for every later connection. A console with a
 * publicly trusted certificate is not pinned (renewals would break the pin);
 * it is checked against the system CAs and its host name instead.
 *
 * Errors carry a short category as their message and never text from the
 * remote end, so the probe cannot be used to read other services on the
 * network. The full error is kept in `detail` for the server log.
 */
import { X509Certificate } from "node:crypto";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";

export type UnifiAuth = { kind: "api_key"; apiKey: string } | { kind: "password"; username: string; password: string };

export interface UnifiClientConfig {
  baseUrl: string;
  site: string;
  auth: UnifiAuth;
  /** Pinned leaf certificate (PEM) and its SHA-256 fingerprint; null for system trust. */
  pin: { fingerprint: string; pem: string } | null;
  /** Standalone Network application (no /proxy/network prefix, /api/login). */
  standalone?: boolean;
  /** Longest silence on a request. */
  timeoutMs?: number;
  /** Longest a whole request may take, however steadily the console trickles data. */
  deadlineMs?: number;
  /** Aborting cancels the request in flight and refuses new ones. */
  signal?: AbortSignal;
}

/** Real consoles answer in a few hundred KB at most. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const PIN_MISMATCH = "OPNMESH_PIN_MISMATCH";

let testCa: string[] | undefined;

/** Tests only: extra trust anchors standing in for a public CA. */
export function setExtraCaForTests(pems: string[] | undefined): void {
  testCa = pems;
}

/** The CA list for system trust; undefined keeps Node's default store. */
function systemCa(): string[] | undefined {
  return testCa ? [...tls.rootCertificates, ...testCa] : undefined;
}

const UNTRUSTED = new Set(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_UNTRUSTED", "CERT_SIGNATURE_FAILURE", "CERT_REJECTED"]);

/** A connection-level failure as a category; `pinned` because a pinned console fails chain checks on any other certificate. */
function networkCategory(e: unknown, pinned: boolean): string {
  const code = (e as { code?: unknown } | null)?.code;
  switch (code) {
    case "ECONNREFUSED":
      return "connection refused";
    case "ECONNRESET":
    case "EPIPE":
      return "connection reset";
    case "ETIMEDOUT":
      return "timed out";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "host not found";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "host unreachable";
    case PIN_MISMATCH:
      return "certificate does not match the pinned fingerprint";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "certificate does not match the host name";
    case "CERT_HAS_EXPIRED":
      return "certificate has expired";
  }
  if (typeof code === "string" && UNTRUSTED.has(code)) return pinned ? "certificate does not match the pinned fingerprint" : "certificate is not trusted";
  if (typeof code === "string" && (code.startsWith("ERR_SSL_") || code === "EPROTO")) return "TLS handshake failed";
  return "connection failed";
}

function errorDetail(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    return code ? `${code}: ${e.message}` : e.message;
  }
  return String(e);
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
  /** The full story for the server log; may contain remote text. */
  public readonly detail: string;
  constructor(
    message: string,
    public readonly status = 0,
    detail?: string,
  ) {
    super(message);
    this.detail = detail ?? message;
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
    // Not trusted yet, so not verified here; `authorized` still reports whether
    // the system CAs and the host name would accept it.
    const sock = tls.connect({ host: u.hostname, port, servername: net.isIP(u.hostname) ? undefined : u.hostname, ca: systemCa(), rejectUnauthorized: false }, () => {
      clearTimeout(timer);
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
    // A deadline, not an idle timeout: a handshake trickled a byte at a time must still end.
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new UnifiError("cannot reach the console: timed out"));
    }, timeoutMs);
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(new UnifiError(`cannot reach the console: ${networkCategory(e, false)}`, 0, errorDetail(e)));
    });
  });
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function cleanText(v: unknown): string | undefined {
  return typeof v === "string" ? v.replace(/\p{Cc}+/gu, " ").trim().slice(0, 64) : undefined;
}

export class UnifiClient {
  private cookie = "";
  private csrf = "";
  private agent: https.Agent | http.Agent;
  private readonly base: URL;
  private readonly timeout: number;
  private readonly deadline: number;

  constructor(private readonly cfg: UnifiClientConfig) {
    this.base = new URL(cfg.baseUrl);
    this.timeout = cfg.timeoutMs ?? 15_000;
    this.deadline = cfg.deadlineMs ?? 20_000;
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
        checkServerIdentity: (_host, cert) => (cert.fingerprint256.toLowerCase() === pin.fingerprint.toLowerCase() ? undefined : Object.assign(new Error("console certificate does not match the pinned fingerprint"), { code: PIN_MISMATCH })),
      });
    } else {
      // No pin: a console with a publicly trusted certificate. Node's defaults
      // check the chain against the system CAs and the host name.
      this.agent = new https.Agent({ keepAlive: true, ca: systemCa() });
    }
  }

  private failure(e: unknown): UnifiError {
    return e instanceof UnifiError ? e : new UnifiError(`cannot reach the console: ${networkCategory(e, this.cfg.pin !== null)}`, 0, errorDetail(e));
  }

  private cancelled(): UnifiError {
    const reason: unknown = this.cfg.signal?.reason;
    return reason instanceof UnifiError ? reason : new UnifiError("request to the console was cancelled");
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
    const signal = this.cfg.signal;
    if (signal?.aborted) throw this.cancelled();
    return new Promise((resolve, reject) => {
      let settled = false;
      // The first reason we gave up wins over the socket errors it causes.
      let cause: UnifiError | undefined;
      const giveUp = (err: UnifiError) => {
        cause ??= err;
        req.destroy(err);
      };
      const finish = (err: UnifiError | null, res?: Response) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onAbort);
        if (err) reject(cause ?? err);
        else resolve(res!);
      };
      const req = mod.request(url, { method, headers, agent: this.agent, timeout: this.timeout }, (res) => {
        const tooLarge = () => new UnifiError("the console's response is too large", 0, `${method} ${path}: response over ${MAX_RESPONSE_BYTES} bytes`);
        if (Number(res.headers["content-length"] ?? 0) > MAX_RESPONSE_BYTES) return giveUp(tooLarge());
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) giveUp(tooLarge());
          else chunks.push(c);
        });
        res.on("end", () => {
          if (cause) return finish(cause);
          try {
            finish(null, { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
          } catch (e) {
            finish(new UnifiError("unexpected response from the console", 0, errorDetail(e)));
          }
        });
        res.on("error", (e) => finish(this.failure(e)));
      });
      const deadline = setTimeout(() => giveUp(new UnifiError("request to the console timed out", 0, `${method} ${path}: no complete response after ${this.deadline} ms`)), this.deadline);
      const onAbort = () => giveUp(this.cancelled());
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("timeout", () => giveUp(new UnifiError("request to the console timed out", 0, `${method} ${path}: idle for ${this.timeout} ms`)));
      req.on("error", (e) => finish(this.failure(e)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /** Log in when using a local account; a no-op with an API key. */
  async login(): Promise<void> {
    if (this.cfg.auth.kind !== "password") return;
    const path = this.cfg.standalone ? "/api/login" : "/api/auth/login";
    const res = await this.raw("POST", path, { username: this.cfg.auth.username, password: this.cfg.auth.password, remember: false });
    if (res.status !== 200) {
      const what = res.status === 401 || res.status === 403 ? "authentication failed" : "unexpected response from the console";
      throw new UnifiError(`${what} (HTTP ${res.status})`, res.status, `POST ${path} → HTTP ${res.status}: ${summarise(res.body)}`);
    }
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
    const detail = `${method} ${path} → HTTP ${res.status}: ${summarise(res.body)}`;
    if (res.status === 401 || res.status === 403) throw new UnifiError(`the console refused the credentials (HTTP ${res.status})`, res.status, detail);
    if (res.status >= 400) throw new UnifiError(`unexpected response from the console (HTTP ${res.status})`, res.status, detail);
    if (!res.body) return undefined as T;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new UnifiError("unexpected response from the console (not JSON)", 0, detail);
    }
  }

  private async list<T>(method: string, path: string): Promise<T[]> {
    const out = await this.json<unknown>(method, path);
    if (!Array.isArray(out)) throw new UnifiError("unexpected response from the console (not a list)", 0, `${method} ${path}: not a list`);
    return out as T[];
  }

  /** Classic API responses wrap data in { meta: { rc }, data: [...] }. */
  private async classic<T>(method: string, path: string, body?: unknown): Promise<T[]> {
    const full = `${this.prefix()}/api/s/${encodeURIComponent(this.cfg.site)}/${path}`;
    const out = await this.json<{ meta?: { rc?: unknown; msg?: unknown }; data?: unknown } | undefined>(method, full, body);
    if (out?.meta?.rc !== undefined && out.meta.rc !== "ok") {
      // UniFi's own error keys are worth showing; anything else stays in the log.
      const msg = typeof out.meta.msg === "string" && /^api\.err\.[\w.]{1,80}$/.test(out.meta.msg) ? ` (${out.meta.msg})` : "";
      throw new UnifiError(`the console reported an error${msg}`, 0, `${method} ${full}: ${summarise(JSON.stringify(out.meta))}`);
    }
    if (out?.data === undefined) return [];
    if (!Array.isArray(out.data)) throw new UnifiError("unexpected response from the console (not a list)", 0, `${method} ${full}: data is not a list`);
    return out.data as T[];
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
      version = cleanText(st?.meta?.server_version);
    } catch {
      /* optional */
    }
    return { name: cleanText(self[0]?.name), version };
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
    return this.list<UnifiZone>("GET", this.v2("firewall/zones"));
  }
  listFirewallPolicies(): Promise<UnifiFirewallPolicy[]> {
    return this.list<UnifiFirewallPolicy>("GET", this.v2("firewall-policies"));
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
