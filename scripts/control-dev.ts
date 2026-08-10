/**
 * Development control server: the agent-facing pull API plus enrolment,
 * backed by sites.yml + registry.json on disk. Used by the compose simulation
 * (bundled into docker/state/control/server.mjs) and for local development.
 * The production control node mounts these same semantics inside the Next.js
 * app later; the admin endpoints here correspond to what become
 * session-authenticated Server Actions.
 *
 * Agent-facing:
 *   GET  /api/v1/agent/config    Bearer-auth'd; node files + hash; ETag/304.
 *                                403 {status:"pending"} until approved.
 *   POST /api/v1/agent/report    Bearer-auth'd status ingest.
 *   POST /api/v1/enrol           one-time-token enrolment (public endpoint).
 *   GET  /install.sh             the installer, with its SHA-256 in a header.
 *
 * Dev/admin (unauthenticated here; session-auth in the real app):
 *   GET  /api/v1/state           node status summary.
 *   POST /api/v1/admin/enrol-tokens {role, note, ttlMs?} → {token, expiresAt}
 *   GET  /api/v1/admin/pending
 *   POST /api/v1/admin/approve  {pendingId, site:{...sites.yml site entry, public_key omitted}}
 *   POST /api/v1/admin/reject   {pendingId}
 *   POST /api/v1/admin/remove   {siteId}   (decommission binding + site)
 *
 * The control node never dials out to nodes. Agents pull.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadSitesYaml } from "../lib/schema.js";
import { generateAll } from "../lib/generator/index.js";
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

const STATE_DIR = process.env["STATE_DIR"] ?? "docker/state";
const PORT = Number(process.env["PORT"] ?? 8080);
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
  peers: Array<{ publicKey?: string; latestHandshake?: number }>;
}

const reports = new Map<string, NodeStatus>();
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
  if (!existsSync(SETTINGS_PATH)) return { frozen: false, updateWindow: "always", pinned: {} };
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as ControlSettings;
}
function saveSettings(s: ControlSettings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n", "utf8");
}

function loadRollout(): RolloutState | null {
  if (!existsSync(ROLLOUT_PATH)) return null;
  return JSON.parse(readFileSync(ROLLOUT_PATH, "utf8")) as RolloutState;
}
function saveRollout(r: RolloutState): void {
  writeFileSync(ROLLOUT_PATH, JSON.stringify(r, null, 2) + "\n", "utf8");
}

function appendAudit(type: string, detail: string): void {
  appendFileSync(AUDIT_PATH, JSON.stringify({ ts: Date.now(), type, detail }) + "\n", "utf8");
  console.log(`audit: ${type}: ${detail}`);
}

function manifestFor(version: string): ReleaseManifest | null {
  const p = join(RELEASES_DIR, version, "manifest.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as ReleaseManifest;
}

/** Digest of the full generated bundle for the current topology. */
function currentConfigDigest(): string {
  const cfg = loadSitesYaml(readFileSync(SITES_PATH, "utf8"));
  const bundle = generateAll(cfg);
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
  if (!existsSync(PORTCHANGE_PATH)) return null;
  return JSON.parse(readFileSync(PORTCHANGE_PATH, "utf8")) as PortChange;
}

function tickPortChange(): void {
  const pc = loadPortChange();
  if (!pc) return;
  const cfg = loadSitesYaml(readFileSync(SITES_PATH, "utf8"));
  const gateways = cfg.sites.map((s) => s.id);
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
    writeFileSync(SITES_PATH, pc.prevYaml, "utf8");
    rmSync(PORTCHANGE_PATH, { force: true });
    appendAudit(
      "port-change:reverted",
      `${pc.siteId} → ${pc.port} failed mesh-wide verification; all nodes reverted`,
    );
  }
}

setInterval(() => {
  try {
    tickRollout();
    tickPortChange();
  } catch (e) {
    console.error("tick error:", e);
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
  if (!existsSync(capturesPath())) return [];
  return JSON.parse(readFileSync(capturesPath(), "utf8")) as CaptureJob[];
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
  const cfg = loadSitesYaml(readFileSync(SITES_PATH, "utf8"));
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
  if (!existsSync(REGISTRY_PATH)) return emptyRegistry();
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Registry;
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

function desiredFor(nodeId: string): { files: Record<string, string>; hash: string } | null {
  const cfg = loadSitesYaml(readFileSync(SITES_PATH, "utf8"));
  const bundle = generateAll(cfg);
  const node = bundle.nodes[nodeId];
  if (!node) return null;
  return { files: node.files, hash: hashFiles(node.files) };
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? "/";

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
      const body = await readBody(req);
      reports.set(auth.siteId, {
        lastSeen: Date.now(),
        version: String(body.version ?? ""),
        appliedHash: String(body.appliedHash ?? ""),
        diskHash: String(body.diskHash ?? ""),
        lastError: String(body.lastError ?? ""),
        lastUpdateError: String(body.lastUpdateError ?? ""),
        peers: Array.isArray(body.peers) ? body.peers : [],
      });
      tickRollout();
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/v1/enrol") {
      const body = await readBody(req);
      const reg = loadRegistry();
      const result = enrol(
        reg,
        {
          token: String(body.token ?? ""),
          publicKey: String(body.publicKey ?? ""),
          hostname: String(body.hostname ?? ""),
          addresses: Array.isArray(body.addresses) ? body.addresses.map(String) : [],
        },
        Date.now(),
      );
      if (!result.ok) return json(res, 400, { error: result.reason });
      saveRegistry(reg);
      console.log(`enrol: pending node ${result.pendingId} (${body.hostname})`);
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
      const rel = url.slice("/api/v1/agent/release/".length);
      const m = rel.match(/^([A-Za-z0-9._-]+)\/(opnmesh-agent(?:\.minisig)?)$/);
      if (!m) return json(res, 400, { error: "bad release path" });
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
      const body = await readBody(req);
      const flows = Array.isArray(body.flows) ? body.flows : [];
      flowStore.ingest(
        flows.map((f: any) => ({
          node: auth.siteId,
          proto: String(f.proto ?? ""),
          src: String(f.src ?? ""),
          dst: String(f.dst ?? ""),
          dstPort: Number(f.dstPort ?? 0),
          bytes: Number(f.bytes ?? 0),
          packets: Number(f.packets ?? 0),
          reported: Number(f.reported ?? Math.floor(Date.now() / 1000)),
        })),
      );
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.startsWith("/api/v1/flows/top")) {
      const params = new URL(url, "http://x").searchParams;
      const windowSec = Number(params.get("window") ?? 3600);
      const limit = Number(params.get("limit") ?? 20);
      const since = Math.floor(Date.now() / 1000) - windowSec;
      return json(res, 200, { top: flowStore.topTalkers(since, limit) });
    }

    if (req.method === "POST" && url === "/api/v1/admin/flows/purge") {
      flowStore.purge();
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url === "/metrics") {
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
        lines.push(`opnmesh_node_drift{node="${siteId}"} ${drift}`);
        lines.push(
          `opnmesh_node_last_seen_timestamp_seconds{node="${siteId}"} ${report ? Math.floor(report.lastSeen / 1000) : 0}`,
        );
        lines.push(`opnmesh_node_reconcile_error{node="${siteId}"} ${report && report.lastError !== "" ? 1 : 0}`);
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
        lines.push(`opnmesh_node_update_error{node="${siteId}"} ${r && r.lastUpdateError !== "" ? 1 : 0}`);
        if (r?.version) lines.push(`opnmesh_node_info{node="${siteId}",version="${r.version}"} 1`);
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
      return json(res, 200, { nodes: out });
    }

    // --- dev/admin endpoints (session-authenticated Server Actions in the real app) ---

    if (req.method === "POST" && url === "/api/v1/admin/enrol-tokens") {
      const body = await readBody(req);
      const reg = loadRegistry();
      const role = (body.role ?? "gateway") as NodeRole;
      const ttl = typeof body.ttlMs === "number" ? body.ttlMs : undefined;
      const token = issueEnrolToken(reg, role, String(body.note ?? ""), Date.now(), ttl);
      saveRegistry(reg);
      const script = existsSync(INSTALL_SH_PATH) ? readFileSync(INSTALL_SH_PATH) : null;
      return json(res, 200, {
        token,
        role,
        expiresAt: reg.enrolTokens[reg.enrolTokens.length - 1]!.expiresAt,
        installShSha256: script ? createHash("sha256").update(script).digest("hex") : null,
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
      const body = await readBody(req);
      const reg = loadRegistry();
      const site = body.site;
      if (!site?.id) return json(res, 400, { error: "site entry required" });
      const node = approve(reg, String(body.pendingId), String(site.id));
      // Approval and topology entry are one operation: the site joins
      // sites.yml with the key the node itself reported.
      const doc = parseYaml(readFileSync(SITES_PATH, "utf8"));
      doc.sites.push({ ...site, gateway: { ...site.gateway, public_key: node.publicKey } });
      // Validate before persisting; a bad approval must not corrupt truth.
      loadSitesYaml(stringifyYaml(doc));
      writeFileSync(SITES_PATH, stringifyYaml(doc), "utf8");
      saveRegistry(reg);
      console.log(`approve: ${node.id} bound to ${site.id}`);
      return json(res, 200, { ok: true, siteId: site.id });
    }

    if (req.method === "POST" && url === "/api/v1/admin/reject") {
      const body = await readBody(req);
      const reg = loadRegistry();
      rejectPending(reg, String(body.pendingId));
      saveRegistry(reg);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/v1/admin/releases") {
      const body = await readBody(req);
      const manifest: ReleaseManifest = {
        version: String(body.version),
        sha256: String(body.sha256),
        configDigest: body.configDigest === undefined ? null : body.configDigest,
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
      const body = await readBody(req);
      const version = String(body.version);
      const manifest = manifestFor(version);
      if (!manifest) return json(res, 400, { error: `unknown release ${version}` });

      // §11 hard invariant: a software update must never change WireGuard
      // configuration as a side effect. A release whose generator produces a
      // different bundle for the current topology is blocked pending
      // explicit approval of the diff.
      if (
        manifest.configDigest != null &&
        manifest.configDigest !== currentConfigDigest() &&
        body.approveConfigChange !== true
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
        String(body.canary ?? cfg.sites[0]!.id),
        Number(body.soakSec ?? 1800),
        Number(body.failTimeoutSec ?? 300),
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
      const body = await readBody(req);
      const settings = loadSettings();
      settings.frozen = body.frozen === true;
      saveSettings(settings);
      appendAudit("freeze", settings.frozen ? "global freeze ON (immediate, incl. mid-rollout)" : "global freeze off");
      return json(res, 200, settings);
    }

    if (req.method === "POST" && url === "/api/v1/admin/pin") {
      const body = await readBody(req);
      const settings = loadSettings();
      settings.pinned[String(body.siteId)] = body.pinned === true;
      saveSettings(settings);
      appendAudit("pin", `${body.siteId} pinned=${body.pinned === true}`);
      return json(res, 200, settings);
    }

    if (req.method === "POST" && url === "/api/v1/admin/window") {
      const body = await readBody(req);
      const settings = loadSettings();
      settings.updateWindow = String(body.updateWindow ?? "always");
      saveSettings(settings);
      appendAudit("window", `maintenance window set to ${settings.updateWindow}`);
      return json(res, 200, settings);
    }

    if (req.method === "GET" && url === "/api/v1/admin/audit") {
      const lines = existsSync(AUDIT_PATH)
        ? readFileSync(AUDIT_PATH, "utf8").trim().split("\n").filter(Boolean).slice(-200)
        : [];
      return json(res, 200, { audit: lines.map((l) => JSON.parse(l)) });
    }

    if (req.method === "POST" && url === "/api/v1/admin/change-port") {
      const body = await readBody(req);
      const siteId = String(body.siteId);
      const port = Number(body.port);
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
        verifyUntilMs: Date.now() + Number(body.verifyWindowSec ?? 120) * 1000,
        affectedTunnels,
      };
      writeFileSync(PORTCHANGE_PATH, JSON.stringify(pc, null, 2) + "\n", "utf8");
      writeFileSync(SITES_PATH, nextYaml, "utf8");
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
      const id = url.slice("/api/v1/agent/capture/".length).replace(/[^a-z0-9-]/g, "");
      const jobs = loadCaptures();
      const job = jobs.find((j) => j.id === id && j.node === auth.siteId);
      if (!job) return json(res, 404, { error: "no such capture" });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > job.maxKb * 1024) break;
        chunks.push(chunk as Buffer);
      }
      mkdirSync(CAPTURES_DIR, { recursive: true });
      writeFileSync(join(CAPTURES_DIR, `${job.id}.pcap`), Buffer.concat(chunks));
      job.status = "done";
      job.sizeKb = Math.round(size / 1024);
      saveCaptures(jobs);
      appendAudit("capture:completed", `${job.id} on ${job.node}: ${job.sizeKb} KiB`);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/v1/admin/capture") {
      const body = await readBody(req);
      const seconds = Math.min(Number(body.seconds ?? 15), CAPTURE_MAX_SECONDS);
      const maxKb = Math.min(Number(body.maxKb ?? 2048), CAPTURE_MAX_KB);
      const node = String(body.node);
      if (!loadRegistry().bindings[node]) return json(res, 400, { error: `unknown node ${node}` });
      const job: CaptureJob = {
        id: "cap-" + Date.now().toString(36),
        node,
        filter: String(body.filter ?? ""),
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
      const file = url.slice("/api/v1/admin/captures/".length).replace(/[^a-z0-9.-]/g, "");
      const p = join(CAPTURES_DIR, file);
      if (!file.endsWith(".pcap") || !existsSync(p)) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": "application/vnd.tcpdump.pcap" });
      return res.end(readFileSync(p));
    }

    if (req.method === "POST" && url === "/api/v1/admin/test-email") {
      const result = await sendTestEmail();
      appendAudit("test-email", result.ok ? "sent" : `failed: ${result.error}`);
      return json(res, result.ok ? 200 : 500, result);
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
      const body = await readBody(req);
      const siteId = String(body.siteId);
      const reg = loadRegistry();
      removeBinding(reg, siteId);
      const doc = parseYaml(readFileSync(SITES_PATH, "utf8"));
      doc.sites = doc.sites.filter((s: any) => s.id !== siteId);
      loadSitesYaml(stringifyYaml(doc));
      writeFileSync(SITES_PATH, stringifyYaml(doc), "utf8");
      saveRegistry(reg);
      reports.delete(siteId);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

// Dev server resilience: log instead of dying, and name the culprit so real
// bugs surface in `docker logs` rather than as silent restarts.
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

server.listen(PORT, () => {
  console.log(`opnmesh control (dev) listening on :${PORT}, state dir ${STATE_DIR}`);
});
