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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  appliedHash: string;
  diskHash: string;
  lastError: string;
  peers: unknown[];
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
        appliedHash: String(body.appliedHash ?? ""),
        diskHash: String(body.diskHash ?? ""),
        lastError: String(body.lastError ?? ""),
        peers: Array.isArray(body.peers) ? body.peers : [],
      });
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
          appliedHash: report?.appliedHash ?? null,
          diskHash: report?.diskHash ?? null,
          lastError: report?.lastError ?? "",
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

server.listen(PORT, () => {
  console.log(`opnmesh control (dev) listening on :${PORT}, state dir ${STATE_DIR}`);
});
