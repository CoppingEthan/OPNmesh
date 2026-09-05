/**
 * A fake UniFi console: the subset of the classic and v2 APIs OPNmesh uses,
 * in memory, over plain HTTP. Used by unit tests and the simulation.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

interface Route extends Record<string, unknown> {
  _id: string;
  name: string;
}

export interface FakeConsole {
  server: Server;
  url: string;
  routes: Route[];
  policies: Array<Record<string, unknown> & { _id: string }>;
  zones: Array<{ _id: string; name: string; default_zone?: boolean }>;
  portForwards: Array<Record<string, unknown>>;
  apiKey: string;
  password: { username: string; password: string };
  requests: Array<{ method: string; path: string; auth: string }>;
  close(): Promise<void>;
}

export async function startFakeConsole(opts: { site?: string; requirePassword?: boolean } = {}): Promise<FakeConsole> {
  const site = opts.site ?? "default";
  const state: FakeConsole = {
    server: null as never,
    url: "",
    routes: [{ _id: "r-user", name: "Users own route", enabled: true, type: "static-route", "static-route_network": "172.16.0.0/16", "static-route_type": "nexthop-route", "static-route_nexthop": "10.0.1.99", "static-route_distance": 1 }],
    policies: [],
    zones: [
      { _id: "z-int", name: "Internal", default_zone: true },
      { _id: "z-ext", name: "External" },
    ],
    portForwards: [],
    apiKey: "test-api-key-" + randomBytes(4).toString("hex"),
    password: { username: "opnmesh", password: "secret-pass" },
    requests: [],
    close: async () => {},
  };
  const sessions = new Set<string>();
  const csrf = "csrf-" + randomBytes(4).toString("hex");

  state.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      const classic = (data: unknown[]) => send(200, { meta: { rc: "ok" }, data });

      // --- auth ---
      const apiKey = req.headers["x-api-key"];
      const cookie = req.headers.cookie ?? "";
      const session = /unifises=([^;]+)/.exec(cookie)?.[1];
      const authed = (!opts.requirePassword && apiKey === state.apiKey) || (session !== undefined && sessions.has(session));
      state.requests.push({ method: req.method ?? "", path, auth: apiKey ? "key" : session ? "cookie" : "none" });

      if (path === "/api/auth/login" && req.method === "POST") {
        if (body?.username === state.password.username && body?.password === state.password.password) {
          const id = randomBytes(8).toString("hex");
          sessions.add(id);
          return send(200, { unique_id: "u1" }, { "set-cookie": `unifises=${id}; Path=/; HttpOnly`, "x-csrf-token": csrf });
        }
        return send(401, { code: "AUTHENTICATION_FAILED_INVALID_CREDENTIALS" });
      }
      if (!authed) return send(401, { code: "API_ERR_UNAUTHORIZED" });
      if (req.method !== "GET" && session && req.headers["x-csrf-token"] !== csrf) return send(403, { code: "CSRF_INVALID" });

      const base = `/proxy/network/api/s/${site}/`;
      const v2 = `/proxy/network/v2/api/site/${site}/`;
      if (path === `${base}self`) return classic([{ name: "opnmesh", site_role: "admin" }]);
      if (path === "/proxy/network/status") return send(200, { meta: { rc: "ok", server_version: "9.3.45" }, data: [] });
      if (path === `${base}rest/routing` && req.method === "GET") return classic(state.routes);
      if (path === `${base}rest/routing` && req.method === "POST") {
        const r = { ...body, _id: "r-" + randomBytes(4).toString("hex"), site_id: "s1" } as Route;
        state.routes.push(r);
        return classic([r]);
      }
      const routeId = path.startsWith(`${base}rest/routing/`) ? decodeURIComponent(path.slice(`${base}rest/routing/`.length)) : null;
      if (routeId && req.method === "PUT") {
        const i = state.routes.findIndex((r) => r._id === routeId);
        if (i < 0) return send(404, { meta: { rc: "error", msg: "api.err.IdInvalid" } });
        state.routes[i] = { ...state.routes[i], ...body, _id: routeId } as Route;
        return classic([state.routes[i]]);
      }
      if (routeId && req.method === "DELETE") {
        const before = state.routes.length;
        state.routes = state.routes.filter((r) => r._id !== routeId);
        return before === state.routes.length ? send(404, { meta: { rc: "error", msg: "api.err.IdInvalid" } }) : classic([]);
      }
      if (path === `${base}rest/networkconf`) return classic([{ _id: "n1", name: "Default", ip_subnet: "10.0.1.1/24" }]);
      if (path === `${base}rest/portforward`) return classic(state.portForwards);
      if (path === `${v2}firewall/zones`) return send(200, state.zones);
      if (path === `${v2}firewall-policies` && req.method === "GET") return send(200, state.policies);
      if (path === `${v2}firewall-policies` && req.method === "POST") {
        const p = { ...body, _id: "p-" + randomBytes(4).toString("hex") };
        state.policies.push(p);
        return send(200, p);
      }
      const policyId = path.startsWith(`${v2}firewall-policies/`) ? decodeURIComponent(path.slice(`${v2}firewall-policies/`.length)) : null;
      if (policyId && req.method === "PUT") {
        const i = state.policies.findIndex((p) => p._id === policyId);
        if (i < 0) return send(404, {});
        state.policies[i] = { ...state.policies[i], ...body, _id: policyId };
        return send(200, state.policies[i]);
      }
      if (policyId && req.method === "DELETE") {
        state.policies = state.policies.filter((p) => p._id !== policyId);
        return send(200, {});
      }
      return send(404, { error: `no route for ${req.method} ${path}` });
    });
  });
  await new Promise<void>((r) => state.server.listen(0, "127.0.0.1", r));
  const addr = state.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  state.url = `http://127.0.0.1:${port}`;
  state.close = () => new Promise((r) => state.server.close(() => r()));
  return state;
}
