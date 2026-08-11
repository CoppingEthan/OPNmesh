/**
 * OPNmesh control server: the agent-facing pull API, enrolment, and the
 * management API the UI drives. Backed by sites.yml + registry.json on disk.
 *
 * Authentication — three tiers, never interchangeable:
 *   PUBLIC   /install.sh, POST /api/v1/enrol (rate limited; enrolment is
 *            gated by a single-use, short-TTL, role-bound token)
 *   NODE     /api/v1/agent/*  — per-node bearer token issued at approval
 *   ADMIN    /api/v1/admin/*, /api/v1/state, /api/v1/flows/*, /metrics —
 *            the admin bearer token (OPNMESH_ADMIN_TOKEN), held only by the UI
 *
 * Transport: HTTPS whenever OPNMESH_TLS_CERT/OPNMESH_TLS_KEY are set (required
 * in production; the server refuses to start over plain HTTP unless
 * OPNMESH_ALLOW_INSECURE_HTTP=1, which exists for the local simulation only).
 *
 * The control node never dials out to nodes. Agents pull.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadSitesYaml, type ResolvedConfig } from "../lib/schema.js";
import { generateAll, type GeneratedBundle } from "../lib/generator/index.js";
import {
  authenticate,
  approve,
  emptyRegistry,
  enrol,
  issueEnrolToken,
  keyFingerprint,
  reject as rejectPending,
  removeBinding,
  type NodeRole,
  type Registry,
} from "../lib/enrol/registry.js";
import { JsonlFlowStore } from "../lib/flows/store.js";
import {
  advance,
  instructionDue,
  markStarted,
  planRollout,
  type ReleaseManifest,
  type RolloutState,
  type NodeReportView,
} from "../lib/update/rollout.js";
import { runValidators } from "../lib/validators/index.js";
import { AdminAuth, RateLimiter, bearerToken as parseBearer } from "../lib/control/auth.js";
import { writeFileAtomic } from "../lib/fs-atomic.js";
import * as S from "../lib/control/schemas.js";

const STATE_DIR = process.env["STATE_DIR"] ?? "docker/state";
const PORT = Number(process.env["PORT"] ?? 8080);
/** Bind address. Defaults to all interfaces because agents must reach it. */
const BIND = process.env["OPNMESH_BIND"] ?? "0.0.0.0";
const TLS_CERT = process.env["OPNMESH_TLS_CERT"] ?? "";
const TLS_KEY = process.env["OPNMESH_TLS_KEY"] ?? "";
const ALLOW_INSECURE_HTTP = process.env["OPNMESH_ALLOW_INSECURE_HTTP"] === "1";

/**
 * Admin credential for the management API. Required — no default, no bypass.
 * Prefer a file (kept out of the process environment and `docker inspect`)
 * and fall back to the variable.
 */
function adminTokenFromEnv(): string | undefined {
  const file = process.env["OPNMESH_ADMIN_TOKEN_FILE"];
  if (file && existsSync(file)) return readFileSync(file, "utf8").trim();
  return process.env["OPNMESH_ADMIN_TOKEN"];
}
const adminAuth = new AdminAuth(adminTokenFromEnv);

/**
 * SHA-256 of our own certificate's public key (SPKI), in the same form the
 * agent pins and the installer's --pin expects. Publishing it lets an operator
 * verify the control node out-of-band instead of trusting whatever answers
 * during enrolment. It is derived from the public certificate only.
 */
function ownCertPin(): string | null {
  if (!TLS_CERT) return null;
  try {
    const cert = new X509Certificate(readFileSync(TLS_CERT));
    const der = cert.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    return createHash("sha256").update(der).digest("hex");
  } catch (e) {
    console.error("could not derive the certificate pin from OPNMESH_TLS_CERT:", e);
    return null;
  }
}

/** Enrolment is public, so it is the one endpoint an attacker can hammer. */
const enrolLimiter = new RateLimiter(10, 15 * 60 * 1000);
/** Blunt backstop against unauthenticated flooding of everything else. */
const publicLimiter = new RateLimiter(300, 60 * 1000);
/**
 * Per-node cap on flow submissions. Each POST may carry 5000 flows, so without
 * a dedicated limit one authenticated node could bury the flow store (and the
 * event loop that reads it) far faster than the blunt per-IP limiter allows.
 * 30/min × 5000 = 150k flows/min/node is ample for honest reporting.
 */
const flowIngestLimiter = new RateLimiter(30, 60 * 1000);
setInterval(() => {
  enrolLimiter.sweep();
  publicLimiter.sweep();
  flowIngestLimiter.sweep();
}, 60_000).unref();

const MAX_BODY_BYTES = 1 << 20; // 1 MiB for JSON endpoints
const MAX_CAPTURE_BYTES = 12 << 20; // capture uploads are capped again per job

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}
/** Dead-man's switch (§10): heartbeat to an external endpoint so the control node's own death is noticed. */
const DEADMAN_URL = process.env["OPNMESH_DEADMAN_URL"] ?? "";
const DEADMAN_INTERVAL_MS = Number(process.env["OPNMESH_DEADMAN_INTERVAL_MS"] ?? 60_000);
const REGISTRY_PATH = join(STATE_DIR, "control", "registry.json");
const SITES_PATH = join(STATE_DIR, "sites.yml");
const INSTALL_SH_PATH = join(STATE_DIR, "control", "install.sh");

interface NodeStatus {
  lastSeen: number;
  version: string;
  appliedHash: string;
  diskHash: string;
  lastError: string;
  lastUpdateError: string;
  peers: Array<{ publicKey?: string; latestHandshake?: number; rxBytes?: number; txBytes?: number }>;
}

const reports = new Map<string, NodeStatus>();

/**
 * Live per-tunnel throughput, derived by differencing successive agent
 * reports. It lives here rather than in the UI because the control server is
 * the one long-lived process that sees every report — the UI may be restarted,
 * scaled out, or (in dev) re-evaluated per request, none of which should lose
 * the baseline needed to turn cumulative counters into a rate.
 *
 * Keyed "a|b" with the ids sorted, so both ends agree on direction.
 */
interface RateSample {
  at: number;
  totals: Map<string, { aToB: number; bToA: number }>;
}
let rateSample: RateSample | null = null;
let currentRates = new Map<string, { aToB: number; bToA: number }>();

function sortedPair(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/** Cumulative bytes per link, normalised to "lower id → higher id". */
function peerTotals(): Map<string, { aToB: number; bToA: number }> {
  const { cfg } = currentBundle();
  const keyToId = new Map<string, string>([
    ...cfg.sites.map((s) => [s.gateway.publicKey, s.id] as const),
    ...cfg.clients.map((c) => [c.publicKey, c.id] as const),
  ]);
  const totals = new Map<string, { aToB: number; bToA: number }>();
  for (const [nodeId, status] of reports) {
    for (const peer of status.peers) {
      const peerId = peer.publicKey ? keyToId.get(peer.publicKey) : undefined;
      if (!peerId) continue;
      const key = sortedPair(nodeId, peerId);
      const fromLow = key.split("|")[0] === nodeId;
      const rx = Number(peer.rxBytes ?? 0);
      const tx = Number(peer.txBytes ?? 0);
      const aToB = fromLow ? tx : rx;
      const bToA = fromLow ? rx : tx;
      const existing = totals.get(key);
      // Both ends count the same tunnel; take the higher (fresher) reading.
      totals.set(
        key,
        existing
          ? { aToB: Math.max(existing.aToB, aToB), bToA: Math.max(existing.bToA, bToA) }
          : { aToB, bToA },
      );
    }
  }
  return totals;
}

function sampleRates(): void {
  let totals: Map<string, { aToB: number; bToA: number }>;
  try {
    totals = peerTotals();
  } catch {
    return; // sites.yml mid-write; try again next tick
  }
  const now = Date.now();
  if (rateSample) {
    const elapsed = (now - rateSample.at) / 1000;
    if (elapsed >= 1 && elapsed <= 120) {
      const rates = new Map<string, { aToB: number; bToA: number }>();
      for (const [key, current] of totals) {
        const before = rateSample.totals.get(key);
        if (!before) continue;
        // A negative delta means the interface was recreated, not negative traffic.
        rates.set(key, {
          aToB: Math.max(0, current.aToB - before.aToB) / elapsed,
          bToA: Math.max(0, current.bToA - before.bToA) / elapsed,
        });
      }
      currentRates = rates;
    }
  }
  rateSample = { at: now, totals };
}
setInterval(sampleRates, 5000).unref();

const flowStore = new JsonlFlowStore(join(STATE_DIR, "control", "flows.jsonl"));
let deadmanLastSuccess = 0;

if (DEADMAN_URL) {
  const beat = async () => {
    try {
      const res = await fetch(DEADMAN_URL, { method: "GET" });
      if (res.ok) deadmanLastSuccess = Date.now();
    } catch {
      /* alerting notices via the metric */
    }
  };
  void beat();
  setInterval(beat, DEADMAN_INTERVAL_MS).unref();
}

// --- update machinery state (persisted so a control restart resumes) ---

const ROLLOUT_PATH = join(STATE_DIR, "control", "rollout.json");
const SETTINGS_PATH = join(STATE_DIR, "control", "settings.json");
const AUDIT_PATH = join(STATE_DIR, "control", "audit.jsonl");
const RELEASES_DIR = join(STATE_DIR, "control", "releases");
const PORTCHANGE_PATH = join(STATE_DIR, "control", "port-change.json");

interface ControlSettings {
  frozen: boolean;
  /** "always" | "never" — a real deployment stores cron-style windows. */
  updateWindow: string;
  pinned: Record<string, boolean>;
}

function loadSettings(): ControlSettings {
  return readJsonOr<ControlSettings>(SETTINGS_PATH, { frozen: false, updateWindow: "always", pinned: {} });
}
function saveSettings(s: ControlSettings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n", "utf8");
}

function loadRollout(): RolloutState | null {
  return readJsonOr<RolloutState | null>(ROLLOUT_PATH, null);
}
function saveRollout(r: RolloutState): void {
  writeFileSync(ROLLOUT_PATH, JSON.stringify(r, null, 2) + "\n", "utf8");
}

function appendAudit(type: string, detail: string): void {
  appendFileSync(AUDIT_PATH, JSON.stringify({ ts: Date.now(), type, detail }) + "\n", "utf8");
  console.log(`audit: ${type}: ${detail}`);
}

function manifestFor(version: string): ReleaseManifest | null {
  return readJsonOr<ReleaseManifest | null>(join(RELEASES_DIR, version, "manifest.json"), null);
}

/** Digest of the full generated bundle for the current topology. */
function currentConfigDigest(): string {
  const { bundle } = currentBundle();
  const h = createHash("sha256");
  for (const id of Object.keys(bundle.nodes).sort()) {
    h.update(hashFiles(bundle.nodes[id]!.files));
  }
  return h.digest("hex");
}

function reportViews(): Record<string, NodeReportView | undefined> {
  const out: Record<string, NodeReportView | undefined> = {};
  for (const [id, r] of reports) {
    out[id] = {
      version: r.version,
      lastError: r.lastError,
      lastUpdateError: r.lastUpdateError,
      lastSeen: r.lastSeen,
    };
  }
  return out;
}

let rolloutAborted = 0;

function tickRollout(): void {
  const rollout = loadRollout();
  if (!rollout || rollout.status !== "running") return;
  const before = JSON.stringify(rollout);
  const settings = loadSettings();
  const events = advance(rollout, reportViews(), Date.now(), {
    pinned: (n) => settings.pinned[n] === true,
  });
  for (const e of events) appendAudit(`rollout:${e.type}`, `${e.node ?? ""} ${e.detail}`.trim());
  if (events.some((e) => e.type === "rollout-aborted")) rolloutAborted = 1;
  // Write-on-change only: sync writes to a bind-mounted state dir are slow
  // enough (Docker Desktop gRPC-FUSE) to stall the event loop if done on
  // every report.
  if (JSON.stringify(rollout) !== before) saveRollout(rollout);
}

// --- coordinated port change (§6): one transaction, mesh-wide verification,
// automatic revert of every node together if the mesh does not re-form ---

interface PortChange {
  siteId: string;
  port: number;
  prevYaml: string;
  startedAt: number;
  verifyUntilMs: number;
  affectedTunnels: string[];
}

function loadPortChange(): PortChange | null {
  return readJsonOr<PortChange | null>(PORTCHANGE_PATH, null);
}

function tickPortChange(): void {
  const pc = loadPortChange();
  if (!pc) return;
  const gateways = currentBundle().cfg.sites.map((s) => s.id);
  const now = Math.floor(Date.now() / 1000);
  const allConverged = gateways.every((id) => {
    const desired = desiredFor(id);
    const r = reports.get(id);
    // Reports must postdate the change — a stale pre-change report proves nothing.
    return desired && r && r.lastSeen > pc.startedAt && r.diskHash === desired.hash;
  });
  const allHandshaken = gateways.every((id) => {
    const r = reports.get(id);
    if (!r) return false;
    return r.peers.some((p) => (p.latestHandshake ?? 0) > now - 180);
  });
  if (allConverged && allHandshaken) {
    rmSync(PORTCHANGE_PATH, { force: true });
    appendAudit("port-change:verified", `${pc.siteId} → ${pc.port}; all tunnels re-established`);
    return;
  }
  if (Date.now() > pc.verifyUntilMs) {
    // Transaction rollback: every node reverts together.
    writeFileAtomic(SITES_PATH, pc.prevYaml);
    rmSync(PORTCHANGE_PATH, { force: true });
    appendAudit(
      "port-change:reverted",
      `${pc.siteId} → ${pc.port} failed mesh-wide verification; all nodes reverted`,
    );
  }
}

setInterval(() => {
  // Independent try blocks: a fault in the rollout tick must not skip the
  // port-change tick, which is what performs the mesh-wide auto-revert. One
  // stuck state file cannot be allowed to leave tunnels down indefinitely.
  try {
    tickRollout();
  } catch (e) {
    console.error("rollout tick error:", e);
  }
  try {
    tickPortChange();
  } catch (e) {
    console.error("port-change tick error:", e);
  }
}, 2000).unref();

// --- tier-4 on-demand capture (§13): queued here, pulled and executed by the
// agent (control never dials nodes), pcap uploaded back. Hard server-side
// caps on duration and size; every request audited. ---

const CAPTURES_DIR = join(STATE_DIR, "control", "captures");
const CAPTURE_MAX_SECONDS = 60;
const CAPTURE_MAX_KB = 10240;

interface CaptureJob {
  id: string;
  node: string;
  filter: string;
  seconds: number;
  maxKb: number;
  status: "queued" | "running" | "done" | "failed";
  createdAt: number;
  sizeKb: number;
}

function capturesPath(): string {
  return join(CAPTURES_DIR, "jobs.json");
}
function loadCaptures(): CaptureJob[] {
  return readJsonOr<CaptureJob[]>(capturesPath(), []);
}
function saveCaptures(jobs: CaptureJob[]): void {
  mkdirSync(CAPTURES_DIR, { recursive: true });
  writeFileSync(capturesPath(), JSON.stringify(jobs, null, 2) + "\n", "utf8");
}

async function sendTestEmail(): Promise<{ ok: boolean; error?: string }> {
  const host = process.env["OPNMESH_SMTP_HOST"];
  const port = Number(process.env["OPNMESH_SMTP_PORT"] ?? 587);
  if (!host) return { ok: false, error: "OPNMESH_SMTP_HOST is not set in the environment" };
  try {
    const nodemailer = await import("nodemailer");
    const user = process.env["OPNMESH_SMTP_USER"];
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: false,
      ...(user ? { auth: { user, pass: process.env["OPNMESH_SMTP_PASSWORD"] ?? "" } } : {}),
    });
    await transport.sendMail({
      from: process.env["OPNMESH_SMTP_FROM"] ?? "opnmesh@localhost",
      to: process.env["OPNMESH_ALERT_TO"] ?? process.env["OPNMESH_SMTP_FROM"] ?? "opnmesh@localhost",
      subject: "OPNmesh test email",
      text: "SMTP is configured correctly. Alerts from Alertmanager will arrive like this.",
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function flowRetentionCutoff(): number {
  const { cfg } = currentBundle();
  return Math.floor(Date.now() / 1000) - cfg.network.flowRetentionDays * 86400;
}
// Retention is enforced continuously, not just at query time.
setInterval(() => {
  try {
    flowStore.prune(flowRetentionCutoff());
  } catch {
    /* next round */
  }
}, 60_000).unref();

function loadRegistry(): Registry {
  return readJsonOr<Registry>(REGISTRY_PATH, emptyRegistry());
}

function saveRegistry(reg: Registry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

/** Must match the agent's hashFiles: sha256 over sorted "name\0content\0". */
function hashFiles(files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    h.update(name, "utf8");
    h.update("\0");
    h.update(files[name]!, "utf8");
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Parsed config + generated bundle for the current sites.yml, memoised on the
 * file's contents.
 *
 * Regenerating per call does not scale and is trivially abusable: generating
 * one node's config builds the bundle for EVERY node, so a 100-node mesh made
 * each agent poll O(100) node-configs, and /api/v1/state and /metrics repeated
 * that once per node again. Routine polling alone was enough to saturate the
 * single-threaded event loop and stall the API the whole mesh depends on.
 *
 * Keying on content rather than mtime keeps this correct: writers replace
 * sites.yml through writeFileSync, and the next read produces a different
 * digest, so a stale bundle can never be served. Reading a few KB of YAML is
 * negligible next to parsing and generating it.
 */
let bundleCache: { key: string; cfg: ResolvedConfig; bundle: GeneratedBundle } | null = null;

function currentBundle(): { cfg: ResolvedConfig; bundle: GeneratedBundle } {
  const raw = readFileSync(SITES_PATH, "utf8");
  const key = createHash("sha256").update(raw).digest("hex");
  if (bundleCache?.key === key) return bundleCache;
  const cfg = loadSitesYaml(raw);
  const bundle = generateAll(cfg);
  bundleCache = { key, cfg, bundle };
  return bundleCache;
}

function desiredFor(nodeId: string): { files: Record<string, string>; hash: string } | null {
  const node = currentBundle().bundle.nodes[nodeId];
  if (!node) return null;
  return { files: node.files, hash: hashFiles(node.files) };
}

function bearerToken(req: IncomingMessage): string | null {
  return parseBearer(req.headers.authorization);
}

/**
 * Escape a Prometheus label VALUE per the exposition format: backslash,
 * double-quote and newline are the three characters that can break out of a
 * `name="value"` label or terminate the line early.
 *
 * A node reports its own `version`, which lands in a `/metrics` label. Without
 * escaping, a node could set version to `x"} 1\nopnmesh_node_drift{node="other"} 0`
 * and forge another node's health line, or embed a newline so Prometheus
 * rejects the whole scrape and every alert goes blind. The schema also
 * constrains version, but escaping here is the durable guarantee: any future
 * label sourced from node- or config-supplied text is safe by construction.
 */
function promLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Read and JSON-parse a state file, returning `fallback` if it is missing OR
 * truncated. These files are written non-atomically and frequently (the 2s
 * tick, every agent report), so a crash mid-write leaves half a line. An
 * unguarded JSON.parse would then throw on every subsequent load — and because
 * the ticks shared one try, a single corrupt rollout.json used to disable
 * port-change auto-revert for the whole mesh. Failing safe keeps the control
 * plane running; the next write heals the file.
 */
function readJsonOr<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    console.error(`state file ${path} is unreadable/corrupt; using a safe default until it is rewritten`);
    return fallback;
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json",
    // These endpoints are an API, never a browser surface.
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Read a JSON body with a hard size cap; oversized requests kill the socket. */
async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      req.destroy();
      throw new HttpError(413, "request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "malformed JSON body");
  }
}

/** Parse + validate a body against a schema, or throw a 400. */
async function body<T>(req: IncomingMessage, schema: { parse: (v: unknown) => T }, limit?: number): Promise<T> {
  const raw = await readBody(req, limit);
  try {
    return schema.parse(raw);
  } catch (e) {
    const issues =
      e && typeof e === "object" && "issues" in e
        ? (e as { issues: Array<{ path: unknown[]; message: string }> }).issues
            .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
            .join("; ")
        : "invalid request body";
    throw new HttpError(400, issues);
  }
}

/**
 * Gate for the management API. Everything under /api/v1/admin, plus the state,
 * flow and metrics views, requires the admin credential — these endpoints can
 * reconfigure the entire mesh and expose full topology and packet captures.
 */
function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (adminAuth.verify(req.headers.authorization)) return true;
  json(res, 401, { error: "unauthorized" });
  return false;
}

const handler = async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = req.url ?? "/";
    if (!publicLimiter.allow(clientIp(req))) {
      return json(res, 429, { error: "too many requests" });
    }

    if (req.method === "GET" && url === "/api/v1/agent/config") {
      const token = bearerToken(req);
      if (!token) return json(res, 401, { error: "unauthorized" });
      const auth = authenticate(loadRegistry(), token);
      if (auth.status === "pending") return json(res, 403, { status: "pending" });
      if (auth.status !== "active") return json(res, 401, { error: "unauthorized" });
      const desired = desiredFor(auth.siteId);
      if (!desired) return json(res, 404, { error: `no site entry for ${auth.siteId}` });
      if (req.headers["if-none-match"] === desired.hash) {
        res.writeHead(304, { etag: desired.hash });
        return res.end();
      }
      return json(res, 200, { nodeId: auth.siteId, files: desired.files, hash: desired.hash }, { etag: desired.hash });
    }

    if (req.method === "POST" && url === "/api/v1/agent/report") {
      const token = bearerToken(req);
      if (!token) return json(res, 401, { error: "unauthorized" });
      const auth = authenticate(loadRegistry(), token);
      if (auth.status !== "active") return json(res, 401, { error: "unauthorized" });
      const report = await body(req, S.agentReportSchema);
      const hadNone = reports.size === 0;
      reports.set(auth.siteId, {
        lastSeen: Date.now(),
        version: report.version,
        appliedHash: report.appliedHash,
        diskHash: report.diskHash,
        lastError: report.lastError,
        lastUpdateError: report.lastUpdateError,
        peers: report.peers,
      });
      // Establish the rate baseline as soon as the first report lands.
      if (hadNone) sampleRates();
      tickRollout();
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/v1/enrol") {
      // Public endpoint: rate limited per source so enrolment tokens cannot be
      // guessed, and validated before it reaches the registry.
      if (!enrolLimiter.allow(clientIp(req))) {
        return json(res, 429, { error: "too many enrolment attempts" });
      }
      const request = await body(req, S.enrolRequestSchema);
      const reg = loadRegistry();
      const result = enrol(reg, request, Date.now());
      if (!result.ok) return json(res, 400, { error: result.reason });
      saveRegistry(reg);
      // Log the pending id only — never the node token.
      console.log(`enrol: pending node ${result.pendingId} from ${clientIp(req)}`);
      return json(res, 200, { status: "pending", nodeToken: result.nodeToken, pendingId: result.pendingId });
    }

    if (req.method === "GET" && url === "/api/v1/agent/update") {
      const token = bearerToken(req);
      if (!token) return json(res, 401, { error: "unauthorized" });
      const auth = authenticate(loadRegistry(), token);
      if (auth.status !== "active") return json(res, 401, { error: "unauthorized" });
      const rollout = loadRollout();
      if (!rollout) {
        res.writeHead(204);
        return res.end();
      }
      const settings = loadSettings();
      const due = instructionDue(rollout, auth.siteId, {
        frozen: settings.frozen,
        windowOpen: settings.updateWindow !== "never",
        pinned: (n) => settings.pinned[n] === true,
      });
      if (!due) {
        res.writeHead(204);
        return res.end();
      }
      const manifest = manifestFor(rollout.version)!;
      for (const e of markStarted(rollout, auth.siteId, Date.now())) {
        appendAudit(`rollout:${e.type}`, `${e.node} ${e.detail}`);
      }
      saveRollout(rollout);
      return json(res, 200, {
        targetVersion: rollout.version,
        binaryPath: `/api/v1/agent/release/${rollout.version}/opnmesh-agent`,
        sigPath: `/api/v1/agent/release/${rollout.version}/opnmesh-agent.minisig`,
        sha256: manifest.sha256,
      });
    }

    if (req.method === "GET" && url.startsWith("/api/v1/agent/release/")) {
      const token = bearerToken(req);
      if (!token) return json(res, 401, { error: "unauthorized" });
      const auth = authenticate(loadRegistry(), token);
      if (auth.status !== "active") return json(res, 401, { error: "unauthorized" });
      const rel = url.slice("/api/v1/agent/release/".length).split("?")[0]!;
      // Version must not be a traversal segment; the leading character rules
      // out "." and ".." outright.
      const m = rel.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/(opnmesh-agent(?:\.minisig)?)$/);
      if (!m || m[1]!.includes("..")) return json(res, 400, { error: "bad release path" });
      const filePath = join(RELEASES_DIR, m[1]!, m[2]!);
      if (!existsSync(filePath)) return json(res, 404, { error: "no such release file" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(readFileSync(filePath));
    }

    if (req.method === "POST" && url === "/api/v1/agent/flows") {
      const token = bearerToken(req);
      if (!token) return json(res, 401, { error: "unauthorized" });
      const auth = authenticate(loadRegistry(), token);
      if (auth.status !== "active") return json(res, 401, { error: "unauthorized" });
      if (!flowIngestLimiter.allow(auth.siteId)) {
        return json(res, 429, { error: "too many flow submissions" });
      }
      const payload = await body(req, S.agentFlowsSchema);
      const now = Math.floor(Date.now() / 1000);
      // Clamp the reported time into a sane band. A far-future value would
      // otherwise survive every retention prune forever (prune keeps
      // reported >= cutoff), letting a node defeat retention and grow the
      // store without bound.
      const clampReported = (r: number | undefined): number => {
        if (r === undefined) return now;
        if (r > now + 300) return now; // no meaningful future flows
        if (r < now - 366 * 86400) return now - 366 * 86400; // older than any retention window
        return r;
      };
      flowStore.ingest(
        payload.flows.map((f) => ({
          node: auth.siteId,
          proto: f.proto,
          src: f.src,
          dst: f.dst,
          dstPort: f.dstPort,
          bytes: f.bytes,
          packets: f.packets,
          reported: clampReported(f.reported),
        })),
      );
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.startsWith("/api/v1/flows/top")) {
      if (!requireAdmin(req, res)) return;
      const params = new URL(url, "http://x").searchParams;
      const q = S.flowQuerySchema.safeParse({
        window: Number(params.get("window") ?? 3600),
        limit: Number(params.get("limit") ?? 30),
      });
      if (!q.success) return json(res, 400, { error: "invalid query" });
      const since = Math.floor(Date.now() / 1000) - q.data.window;
      return json(res, 200, { top: flowStore.topTalkers(since, q.data.limit) });
    }

    if (req.method === "POST" && url === "/api/v1/admin/flows/purge") {
      if (!requireAdmin(req, res)) return;
      flowStore.purge();
      appendAudit("flows:purged", "all per-host flow records deleted");
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url === "/metrics") {
      // Telemetry exposes topology and node health: admin credential required
      // (Prometheus scrapes it with authorization.credentials_file).
      if (!requireAdmin(req, res)) return;
      // Control-side metrics: node convergence, enrolment queue, dead-man.
      const reg = loadRegistry();
      const lines: string[] = [
        "# TYPE opnmesh_node_drift gauge",
        "# TYPE opnmesh_node_last_seen_timestamp_seconds gauge",
        "# TYPE opnmesh_node_reconcile_error gauge",
      ];
      for (const siteId of Object.keys(reg.bindings)) {
        const desired = desiredFor(siteId);
        const report = reports.get(siteId);
        const drift = desired && report && report.diskHash !== desired.hash ? 1 : 0;
        lines.push(`opnmesh_node_drift{node="${promLabel(siteId)}"} ${drift}`);
        lines.push(
          `opnmesh_node_last_seen_timestamp_seconds{node="${promLabel(siteId)}"} ${report ? Math.floor(report.lastSeen / 1000) : 0}`,
        );
        lines.push(`opnmesh_node_reconcile_error{node="${promLabel(siteId)}"} ${report && report.lastError !== "" ? 1 : 0}`);
      }
      lines.push("# TYPE opnmesh_pending_nodes gauge", `opnmesh_pending_nodes ${reg.pending.length}`);
      lines.push(
        "# TYPE opnmesh_deadman_last_success_timestamp_seconds gauge",
        `opnmesh_deadman_last_success_timestamp_seconds ${Math.floor(deadmanLastSuccess / 1000)}`,
      );
      lines.push("# TYPE opnmesh_flow_records gauge", `opnmesh_flow_records ${flowStore.count()}`);
      const rollout = loadRollout();
      lines.push(
        "# TYPE opnmesh_rollout_active gauge",
        `opnmesh_rollout_active ${rollout && rollout.status === "running" ? 1 : 0}`,
        "# TYPE opnmesh_rollout_aborted gauge",
        `opnmesh_rollout_aborted ${rolloutAborted || (rollout?.status === "aborted" ? 1 : 0)}`,
      );
      lines.push("# TYPE opnmesh_node_update_error gauge", "# TYPE opnmesh_node_info gauge");
      for (const siteId of Object.keys(reg.bindings)) {
        const r = reports.get(siteId);
        lines.push(`opnmesh_node_update_error{node="${promLabel(siteId)}"} ${r && r.lastUpdateError !== "" ? 1 : 0}`);
        if (r?.version) lines.push(`opnmesh_node_info{node="${siteId}",version="${promLabel(r.version)}"} 1`);
      }
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      return res.end(lines.join("\n") + "\n");
    }

    if (req.method === "GET" && url === "/install.sh") {
      const script = readFileSync(INSTALL_SH_PATH);
      const sha = createHash("sha256").update(script).digest("hex");
      res.writeHead(200, { "content-type": "text/x-shellscript", "x-install-sha256": sha });
      return res.end(script);
    }

    if (req.method === "GET" && url === "/api/v1/state") {
      // Full topology, public keys, peer endpoints and handshake state.
      if (!requireAdmin(req, res)) return;
      const reg = loadRegistry();
      const out: Record<string, unknown> = {};
      for (const siteId of Object.keys(reg.bindings)) {
        const desired = desiredFor(siteId);
        const report = reports.get(siteId);
        out[siteId] = {
          desiredHash: desired?.hash ?? null,
          lastSeen: report?.lastSeen ?? null,
          version: report?.version ?? "",
          appliedHash: report?.appliedHash ?? null,
          diskHash: report?.diskHash ?? null,
          lastError: report?.lastError ?? "",
          lastUpdateError: report?.lastUpdateError ?? "",
          drift: Boolean(desired && report && report.diskHash !== desired.hash),
          peers: report?.peers ?? [],
        };
      }
      // Live per-link byte rates, so the dashboard diagram can show direction
      // and volume without every client keeping its own counter baseline.
      const rates: Record<string, { aToB: number; bToA: number }> = {};
      for (const [key, value] of currentRates) rates[key] = value;
      return json(res, 200, { nodes: out, rates });
    }

    // --- management API: every route below requires the admin credential ---

    if (url.startsWith("/api/v1/admin/") && !requireAdmin(req, res)) return;

    if (req.method === "POST" && url === "/api/v1/admin/enrol-tokens") {
      const request = await body(req, S.issueTokenSchema);
      const reg = loadRegistry();
      const role = request.role as NodeRole;
      const token = issueEnrolToken(reg, role, request.note, Date.now(), request.ttlMs);
      saveRegistry(reg);
      const script = existsSync(INSTALL_SH_PATH) ? readFileSync(INSTALL_SH_PATH) : null;
      appendAudit("enrol:token-issued", `role=${role} note=${request.note}`);
      return json(res, 200, {
        token,
        role,
        expiresAt: reg.enrolTokens[reg.enrolTokens.length - 1]!.expiresAt,
        installShSha256: script ? createHash("sha256").update(script).digest("hex") : null,
        // So the operator can pass --pin and verify the control node rather
        // than trusting whichever host answers during enrolment.
        certPin: ownCertPin(),
      });
    }

    if (req.method === "GET" && url === "/api/v1/admin/pending") {
      const reg = loadRegistry();
      return json(res, 200, {
        pending: reg.pending.map((p) => ({
          id: p.id,
          role: p.role,
          publicKey: p.publicKey,
          fingerprint: keyFingerprint(p.publicKey),
          hostname: p.hostname,
          addresses: p.addresses,
          enrolledAt: p.enrolledAt,
        })),
      });
    }

    if (req.method === "POST" && url === "/api/v1/admin/approve") {
      const request = await body(req, S.approveSchema);
      const reg = loadRegistry();
      const site = request.site;
      const node = approve(reg, request.pendingId, site.id);
      // Approval and topology entry are one operation: the site joins
      // sites.yml with the key the node itself reported. The schema above is
      // a strict allowlist — no caller-supplied field can reach the generated
      // config except the ones listed there (notably NOT private_key_path,
      // which would land in a PostUp command line).
      const doc = parseYaml(readFileSync(SITES_PATH, "utf8"));
      doc.sites.push({ ...site, gateway: { ...site.gateway, public_key: node.publicKey } });
      // Validate before persisting; a bad approval must not corrupt truth.
      loadSitesYaml(stringifyYaml(doc));
      writeFileAtomic(SITES_PATH, stringifyYaml(doc));
      saveRegistry(reg);
      appendAudit("enrol:approved", `${node.hostname} bound to ${site.id}`);
      return json(res, 200, { ok: true, siteId: site.id });
    }

    if (req.method === "POST" && url === "/api/v1/admin/reject") {
      const request = await body(req, S.pendingIdSchema);
      const reg = loadRegistry();
      rejectPending(reg, request.pendingId);
      saveRegistry(reg);
      appendAudit("enrol:rejected", request.pendingId);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/v1/admin/releases") {
      const request = await body(req, S.registerReleaseSchema);
      const manifest: ReleaseManifest = {
        version: request.version,
        sha256: request.sha256,
        configDigest: request.configDigest ?? null,
      };
      const dir = join(RELEASES_DIR, manifest.version);
      if (!existsSync(join(dir, "opnmesh-agent"))) {
        return json(res, 400, { error: `no binary at ${dir}` });
      }
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
      appendAudit("release:registered", `${manifest.version} sha256=${manifest.sha256.slice(0, 12)}`);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/v1/admin/rollout") {
      const request = await body(req, S.startRolloutSchema);
      const version = request.version;
      const manifest = manifestFor(version);
      if (!manifest) return json(res, 400, { error: `unknown release ${version}` });

      // §11 hard invariant: a software update must never change WireGuard
      // configuration as a side effect. A release whose generator produces a
      // different bundle for the current topology is blocked pending
      // explicit approval of the diff.
      if (
        manifest.configDigest != null &&
        manifest.configDigest !== currentConfigDigest() &&
        request.approveConfigChange !== true
      ) {
        appendAudit("rollout:blocked", `${version}: generated config would change; approval required`);
        return json(res, 409, {
          blocked: true,
          reason: "this release generates different WireGuard config for the current topology — review the diff and approve explicitly",
        });
      }

      const cfg = loadSitesYaml(readFileSync(SITES_PATH, "utf8"));
      const rollout = planRollout(
        cfg,
        version,
        request.canary ?? cfg.sites[0]!.id,
        request.soakSec ?? 1800,
        request.failTimeoutSec ?? 300,
        Date.now(),
      );
      rolloutAborted = 0;
      saveRollout(rollout);
      appendAudit("rollout:created", `${version} plan=[${rollout.plan.join(", ")}] canary=${rollout.canary}`);
      return json(res, 200, rollout);
    }

    if (req.method === "GET" && url === "/api/v1/admin/rollout") {
      return json(res, 200, { rollout: loadRollout(), settings: loadSettings() });
    }

    if (req.method === "POST" && url === "/api/v1/admin/rollout/cancel") {
      const rollout = loadRollout();
      if (rollout && rollout.status === "running") {
        rollout.status = "aborted";
        rollout.abortReason = "cancelled by operator";
        saveRollout(rollout);
        appendAudit("rollout:cancelled", `${rollout.version} cancelled by operator`);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/v1/admin/freeze") {
      const request = await body(req, S.freezeSchema);
      const settings = loadSettings();
      settings.frozen = request.frozen;
      saveSettings(settings);
      appendAudit("freeze", settings.frozen ? "global freeze ON (immediate, incl. mid-rollout)" : "global freeze off");
      return json(res, 200, settings);
    }

    if (req.method === "POST" && url === "/api/v1/admin/pin") {
      const request = await body(req, S.pinSchema);
      const settings = loadSettings();
      settings.pinned[request.siteId] = request.pinned;
      saveSettings(settings);
      appendAudit("pin", `${request.siteId} pinned=${request.pinned}`);
      return json(res, 200, settings);
    }

    if (req.method === "POST" && url === "/api/v1/admin/window") {
      const request = await body(req, S.windowSchema);
      const settings = loadSettings();
      settings.updateWindow = request.updateWindow;
      saveSettings(settings);
      appendAudit("window", `maintenance window set to ${settings.updateWindow}`);
      return json(res, 200, settings);
    }

    if (req.method === "GET" && url === "/api/v1/admin/audit") {
      const lines = existsSync(AUDIT_PATH)
        ? readFileSync(AUDIT_PATH, "utf8").trim().split("\n").filter(Boolean).slice(-200)
        : [];
      // A truncated final line (crash mid-append) must not 500 the page.
      const audit: unknown[] = [];
      for (const l of lines) {
        try {
          audit.push(JSON.parse(l));
        } catch {
          /* skip corrupt entry */
        }
      }
      return json(res, 200, { audit });
    }

    if (req.method === "POST" && url === "/api/v1/admin/change-port") {
      const request = await body(req, S.changePortSchema);
      const siteId = request.siteId;
      const port = request.port;
      // One port change at a time. A second overlapping change would overwrite
      // the singleton transaction record — leaving the first change untracked
      // (never auto-reverted if its mesh never re-forms) and snapshotting the
      // first change's unverified port as the second's rollback target.
      if (loadPortChange()) {
        return json(res, 409, {
          error: "a port change is already in progress; wait for it to verify or revert before starting another",
        });
      }
      const prevYaml = readFileSync(SITES_PATH, "utf8");
      const doc = parseYaml(prevYaml);
      const site = doc.sites.find((s: any) => s.id === siteId);
      if (!site) return json(res, 400, { error: `unknown site ${siteId}` });
      site.gateway.listen_port = port;
      const nextYaml = stringifyYaml(doc);
      // Validate the whole future config before touching truth.
      const cfg = loadSitesYaml(nextYaml);
      const findings = runValidators(cfg, generateAll(cfg)).filter((f) => f.level === "error");
      if (findings.length > 0) return json(res, 400, { error: findings.map((f) => f.message) });

      // One transaction across all affected nodes: every peer's config
      // changes together, and verification is mesh-wide.
      const affectedTunnels = cfg.sites.filter((s) => s.id !== siteId).map((s) => `${siteId} ↔ ${s.id}`);
      const pc: PortChange = {
        siteId,
        port,
        prevYaml,
        startedAt: Date.now(),
        verifyUntilMs: Date.now() + (request.verifyWindowSec ?? 120) * 1000,
        affectedTunnels,
      };
      writeFileSync(PORTCHANGE_PATH, JSON.stringify(pc, null, 2) + "\n", "utf8");
      writeFileAtomic(SITES_PATH, nextYaml);
      appendAudit(
        "port-change:started",
        `${siteId} → udp/${port}; brief interruption expected on: ${affectedTunnels.join(", ")}`,
      );
      return json(res, 200, {
        ok: true,
        warning: "a port change causes a brief interruption on the listed tunnels; all nodes revert together if the mesh does not re-form",
        affectedTunnels,
      });
    }

    if (req.method === "GET" && url === "/api/v1/admin/port-change") {
      return json(res, 200, { active: loadPortChange() });
    }

    if (req.method === "GET" && url === "/api/v1/agent/capture") {
      const token = bearerToken(req);
      if (!token) return json(res, 401, { error: "unauthorized" });
      const auth = authenticate(loadRegistry(), token);
      if (auth.status !== "active") return json(res, 401, { error: "unauthorized" });
      const jobs = loadCaptures();
      const job = jobs.find((j) => j.node === auth.siteId && j.status === "queued");
      if (!job) {
        res.writeHead(204);
        return res.end();
      }
      job.status = "running";
      saveCaptures(jobs);
      return json(res, 200, { id: job.id, filter: job.filter, seconds: job.seconds, maxKb: job.maxKb });
    }

    if (req.method === "POST" && url.startsWith("/api/v1/agent/capture/")) {
      const token = bearerToken(req);
      if (!token) return json(res, 401, { error: "unauthorized" });
      const auth = authenticate(loadRegistry(), token);
      if (auth.status !== "active") return json(res, 401, { error: "unauthorized" });
      const id = url.slice("/api/v1/agent/capture/".length).split("?")[0]!;
      if (!/^cap-[a-z0-9]{1,32}$/.test(id)) return json(res, 400, { error: "bad capture id" });
      const jobs = loadCaptures();
      const job = jobs.find((j) => j.id === id && j.node === auth.siteId);
      if (!job) return json(res, 404, { error: "no such capture" });
      const cap = Math.min(job.maxKb * 1024, MAX_CAPTURE_BYTES);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > cap) {
          req.destroy();
          job.status = "failed";
          saveCaptures(jobs);
          return json(res, 413, { error: "capture exceeded its size cap" });
        }
        chunks.push(chunk as Buffer);
      }
      mkdirSync(CAPTURES_DIR, { recursive: true });
      // basename() pins the write inside CAPTURES_DIR even if the id regex
      // above is ever loosened.
      writeFileSync(join(CAPTURES_DIR, basename(`${job.id}.pcap`)), Buffer.concat(chunks));
      job.status = "done";
      job.sizeKb = Math.round(size / 1024);
      saveCaptures(jobs);
      appendAudit("capture:completed", `${job.id} on ${job.node}: ${job.sizeKb} KiB`);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/v1/admin/capture") {
      const request = await body(req, S.captureSchema);
      const seconds = Math.min(request.seconds, CAPTURE_MAX_SECONDS);
      const maxKb = Math.min(request.maxKb, CAPTURE_MAX_KB);
      const node = request.node;
      if (!loadRegistry().bindings[node]) return json(res, 400, { error: `unknown node ${node}` });
      const job: CaptureJob = {
        // Unpredictable id: the pcap is fetched by id, so a guessable one
        // would let a lower-privileged reader race for someone else's capture.
        id: "cap-" + randomBytes(8).toString("hex"),
        node,
        // The filter is a BPF expression only — schemas.ts rejects anything
        // that could be read as a tcpdump option (notably -z, which runs a
        // command as root). agent/capture.go re-checks independently.
        filter: request.filter,
        seconds,
        maxKb,
        status: "queued",
        createdAt: Date.now(),
        sizeKb: 0,
      };
      const jobs = loadCaptures();
      jobs.push(job);
      saveCaptures(jobs);
      appendAudit("capture:requested", `${job.id} on ${node}: ${seconds}s, ≤${maxKb} KiB, filter "${job.filter}"`);
      return json(res, 200, { id: job.id });
    }

    if (req.method === "GET" && url === "/api/v1/admin/captures") {
      return json(res, 200, { captures: loadCaptures().slice(-30).reverse() });
    }

    if (req.method === "GET" && url.startsWith("/api/v1/admin/captures/")) {
      const file = url.slice("/api/v1/admin/captures/".length).split("?")[0]!;
      if (!/^cap-[a-z0-9]{1,32}\.pcap$/.test(file)) return json(res, 404, { error: "not found" });
      const p = join(CAPTURES_DIR, basename(file));
      if (!existsSync(p)) return json(res, 404, { error: "not found" });
      res.writeHead(200, {
        "content-type": "application/vnd.tcpdump.pcap",
        "content-disposition": `attachment; filename="${basename(file)}"`,
      });
      return res.end(readFileSync(p));
    }

    if (req.method === "POST" && url === "/api/v1/admin/test-email") {
      const result = await sendTestEmail();
      appendAudit("test-email", result.ok ? "sent" : "failed");
      if (result.ok) return json(res, 200, { ok: true });
      // The raw SMTP error names the host and user; log it, return a summary.
      console.error("test-email failed:", result.error);
      return json(res, 500, { ok: false, error: "SMTP send failed — see the control node log for details" });
    }

    if (req.method === "GET" && url === "/api/v1/admin/releases") {
      const out: unknown[] = [];
      if (existsSync(RELEASES_DIR)) {
        const { readdirSync } = await import("node:fs");
        for (const v of readdirSync(RELEASES_DIR)) {
          const m = manifestFor(v);
          if (m) out.push(m);
        }
      }
      return json(res, 200, { releases: out });
    }

    if (req.method === "POST" && url === "/api/v1/admin/remove") {
      const request = await body(req, S.siteIdSchema);
      const siteId = request.siteId;
      const reg = loadRegistry();
      removeBinding(reg, siteId);
      const doc = parseYaml(readFileSync(SITES_PATH, "utf8"));
      doc.sites = doc.sites.filter((s: any) => s.id !== siteId);
      loadSitesYaml(stringifyYaml(doc));
      writeFileAtomic(SITES_PATH, stringifyYaml(doc));
      saveRegistry(reg);
      reports.delete(siteId);
      appendAudit("node:removed", siteId);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    // Referencing something that does not exist is a 400, not a server fault.
    const msg = e instanceof Error ? e.message : "";
    if (/^(no pending node|no binding for|site .* already has a bound node|unknown site)/.test(msg)) {
      return json(res, 400, { error: msg });
    }
    // Never return internal detail (paths, stacks) to a caller.
    const ref = randomBytes(6).toString("hex");
    console.error(`[${ref}] unhandled error on ${req.method} ${req.url}:`, e);
    json(res, 500, { error: `internal error (reference ${ref})` });
  }
};

// Resilience: log instead of dying, and name the culprit so real bugs surface
// in the container log rather than as silent restarts.
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

/**
 * Transport. Node bearer tokens ride every poll, so plaintext is only ever
 * acceptable on an isolated lab network — and then only with an explicit
 * opt-in, so nobody reaches production by accident.
 */
const useTls = TLS_CERT !== "" && TLS_KEY !== "";
if (!useTls && !ALLOW_INSECURE_HTTP) {
  console.error(
    "refusing to start without TLS: set OPNMESH_TLS_CERT and OPNMESH_TLS_KEY,\n" +
      "or set OPNMESH_ALLOW_INSECURE_HTTP=1 for an isolated lab/simulation only.",
  );
  process.exit(1);
}

const server = useTls
  ? createHttpsServer(
      {
        cert: readFileSync(TLS_CERT),
        key: readFileSync(TLS_KEY),
        minVersion: "TLSv1.2",
        honorCipherOrder: true,
      },
      handler,
    )
  : createHttpServer(handler);

// Slowloris and hung-request protection.
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 15_000;

server.listen(PORT, BIND, () => {
  const scheme = useTls ? "https" : "http (INSECURE — lab use only)";
  console.log(`OPNmesh control server listening on ${scheme}://${BIND}:${PORT}, state dir ${STATE_DIR}`);
});
