/**
 * Development control server: the agent-facing pull API, backed by a
 * sites.yml on disk. Used by the compose simulation (bundled into
 * docker/state/control/server.mjs) and for local development. The production
 * control node mounts these same semantics inside the Next.js app later.
 *
 * Endpoints:
 *   GET  /api/v1/agent/config   Bearer-auth'd; returns this node's files + hash; ETag/304.
 *   POST /api/v1/agent/report   Bearer-auth'd; agent status ingest.
 *   GET  /api/v1/state          unauthenticated summary for tests/dev UI.
 *
 * The control node never dials out to nodes. Agents pull.
 * NOTE (sim only): tokens are compared as an in-memory map lookup here; the
 * production enrolment path (phase 4) stores only token hashes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSitesYaml } from "../lib/schema.js";
import { generateAll } from "../lib/generator/index.js";

const STATE_DIR = process.env["STATE_DIR"] ?? "docker/state";
const PORT = Number(process.env["PORT"] ?? 8080);

interface NodeStatus {
  lastSeen: number;
  appliedHash: string;
  diskHash: string;
  lastError: string;
  peers: unknown[];
}

const reports = new Map<string, NodeStatus>();

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

function tokens(): Record<string, string> {
  return JSON.parse(readFileSync(join(STATE_DIR, "control", "tokens.json"), "utf8"));
}

function desiredFor(nodeId: string): { files: Record<string, string>; hash: string } | null {
  const cfg = loadSitesYaml(readFileSync(join(STATE_DIR, "sites.yml"), "utf8"));
  const bundle = generateAll(cfg);
  const node = bundle.nodes[nodeId];
  if (!node) return null;
  return { files: node.files, hash: hashFiles(node.files) };
}

function authNode(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return tokens()[token] ?? null;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? "/";

    if (req.method === "GET" && url === "/api/v1/agent/config") {
      const nodeId = authNode(req);
      if (!nodeId) return json(res, 401, { error: "unauthorized" });
      const desired = desiredFor(nodeId);
      if (!desired) return json(res, 404, { error: `no such node ${nodeId}` });
      if (req.headers["if-none-match"] === desired.hash) {
        res.writeHead(304, { etag: desired.hash });
        return res.end();
      }
      return json(res, 200, { nodeId, files: desired.files, hash: desired.hash }, { etag: desired.hash });
    }

    if (req.method === "POST" && url === "/api/v1/agent/report") {
      const nodeId = authNode(req);
      if (!nodeId) return json(res, 401, { error: "unauthorized" });
      const body = JSON.parse(await readBody(req)) as Partial<NodeStatus> & { peers?: unknown[] };
      reports.set(nodeId, {
        lastSeen: Date.now(),
        appliedHash: String(body.appliedHash ?? ""),
        diskHash: String(body.diskHash ?? ""),
        lastError: String(body.lastError ?? ""),
        peers: Array.isArray(body.peers) ? body.peers : [],
      });
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url === "/api/v1/state") {
      const out: Record<string, unknown> = {};
      for (const [token, nodeId] of Object.entries(tokens())) {
        void token;
        const desired = desiredFor(nodeId);
        const report = reports.get(nodeId);
        out[nodeId] = {
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

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`opnmesh control (dev) listening on :${PORT}, state dir ${STATE_DIR}`);
});
