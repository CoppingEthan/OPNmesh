import { join } from "node:path";

/** Where sites.yml and the operator's local config repo live. */
export const STATE_DIR = process.env["OPNMESH_STATE_DIR"] ?? join(process.cwd(), "docker", "state");

/** The agent-facing control server (health/rollout/flow state lives there). */
export const CONTROL_URL = process.env["OPNMESH_CONTROL_URL"] ?? "http://localhost:18080";

/**
 * Credential for the control server's management API. The UI is the only
 * holder. Absent it, every management call fails closed rather than silently
 * reaching an unauthenticated endpoint.
 */
export const CONTROL_ADMIN_TOKEN = process.env["OPNMESH_ADMIN_TOKEN"] ?? "";

/** UI-local data: sessions DB, admin credential hash. Never in the repo. */
export const DATA_DIR = process.env["OPNMESH_DATA_DIR"] ?? join(process.cwd(), ".data");

export const SITES_PATH = join(STATE_DIR, "sites.yml");
