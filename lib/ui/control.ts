/**
 * Typed client for the control server's HTTP API — live node state, flows,
 * rollouts, enrolment, audit. Config truth (sites.yml) is NOT accessed
 * through here; the UI reads and writes it directly via lib/ui/sites.
 */
import { CONTROL_URL, CONTROL_ADMIN_TOKEN } from "./env.js";

export class ControlError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!CONTROL_ADMIN_TOKEN) {
    throw new ControlError(
      500,
      "OPNMESH_ADMIN_TOKEN is not set — the panel cannot authenticate to the control server",
    );
  }
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${CONTROL_ADMIN_TOKEN}`,
    },
    cache: "no-store",
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${CONTROL_URL}${path}`, init);
  // 409 is a meaningful answer (config-neutrality block), not a failure.
  if (!res.ok && res.status !== 409) {
    let detail = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      /* non-JSON body */
    }
    throw new ControlError(res.status, `control ${method} ${path}: ${detail}`);
  }
  return (await res.json()) as T;
}

/** Streams an authenticated file (e.g. a pcap) from the control server. */
export async function controlFetch(path: string): Promise<Response> {
  return fetch(`${CONTROL_URL}${path}`, {
    headers: { authorization: `Bearer ${CONTROL_ADMIN_TOKEN}` },
    cache: "no-store",
  });
}

export interface NodeState {
  desiredHash: string | null;
  lastSeen: number | null;
  version: string;
  appliedHash: string | null;
  diskHash: string | null;
  lastError: string;
  lastUpdateError: string;
  drift: boolean;
  peers: Array<{ publicKey: string; endpoint: string; latestHandshake: number; rxBytes: number; txBytes: number }>;
}

export const control = {
  state: () =>
    req<{ nodes: Record<string, NodeState>; rates?: Record<string, { aToB: number; bToA: number }> }>(
      "GET",
      "/api/v1/state",
    ),
  pending: () =>
    req<{ pending: Array<{ id: string; role: string; publicKey: string; fingerprint: string; hostname: string; addresses: string[]; enrolledAt: number }> }>(
      "GET",
      "/api/v1/admin/pending",
    ),
  issueToken: (role: string, note: string) =>
    req<{ token: string; expiresAt: number; installShSha256: string | null }>("POST", "/api/v1/admin/enrol-tokens", {
      role,
      note,
    }),
  approve: (pendingId: string, site: unknown) => req("POST", "/api/v1/admin/approve", { pendingId, site }),
  reject: (pendingId: string) => req("POST", "/api/v1/admin/reject", { pendingId }),
  removeNode: (siteId: string) => req("POST", "/api/v1/admin/remove", { siteId }),
  flowsTop: (windowSec: number, limit = 30) =>
    req<{ top: Array<{ src: string; dst: string; proto: string; dstPort: number; bytes: number; packets: number }> }>(
      "GET",
      `/api/v1/flows/top?window=${windowSec}&limit=${limit}`,
    ),
  flowsPurge: () => req("POST", "/api/v1/admin/flows/purge"),
  rollout: () => req<{ rollout: any; settings: { frozen: boolean; updateWindow: string; pinned: Record<string, boolean> } }>("GET", "/api/v1/admin/rollout"),
  createRollout: (body: unknown) => req<any>("POST", "/api/v1/admin/rollout", body),
  cancelRollout: () => req("POST", "/api/v1/admin/rollout/cancel"),
  freeze: (frozen: boolean) => req("POST", "/api/v1/admin/freeze", { frozen }),
  pin: (siteId: string, pinned: boolean) => req("POST", "/api/v1/admin/pin", { siteId, pinned }),
  setWindow: (updateWindow: string) => req("POST", "/api/v1/admin/window", { updateWindow }),
  audit: () => req<{ audit: Array<{ ts: number; type: string; detail: string }> }>("GET", "/api/v1/admin/audit"),
  changePort: (siteId: string, port: number) =>
    req<{ ok?: boolean; warning?: string; affectedTunnels?: string[]; error?: unknown }>(
      "POST",
      "/api/v1/admin/change-port",
      { siteId, port },
    ),
  portChange: () => req<{ active: unknown }>("GET", "/api/v1/admin/port-change"),
  testEmail: () => req<{ ok?: boolean; error?: string }>("POST", "/api/v1/admin/test-email"),
  captureStart: (body: unknown) => req<{ id?: string; error?: string }>("POST", "/api/v1/admin/capture", body),
  captures: () => req<{ captures: Array<{ id: string; node: string; status: string; sizeKb: number; createdAt: number }> }>("GET", "/api/v1/admin/captures"),
};
