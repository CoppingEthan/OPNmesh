#!/usr/bin/env node
/**
 * Deployment smoke test: checks a controller installed by
 * deploy/controller/install.sh the way a first install behaves, with Caddy
 * in front issuing certificates from its private CA and the controller
 * running as the image's unprivileged user on a bind-mounted data directory.
 * CI runs it against a locally built image; it works against any such
 * deployment.
 *
 *   sudo -E node scripts/deploy-smoke.mjs --dir /opt/opnmesh --url https://203.0.113.5
 *
 * Root is needed only to read data/setup-code, which the controller writes
 * for its own user alone.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const dir = opt("--dir", "/opt/opnmesh");
const base = opt("--url", "").replace(/\/+$/, "");
if (!base.startsWith("https://")) {
  console.error("usage: deploy-smoke.mjs --dir <install dir> --url https://<host>[:port]");
  process.exit(2);
}
// Caddy's data directory is /data inside its container (./caddy on the host)
// and it keeps its files under a further caddy/ directory.
const caFile = join(dir, "caddy", "caddy", "pki", "authorities", "local", "root.crt");

let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? "  ok " : " FAIL"} ${msg}`);
  if (!ok) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(path, { method = "GET", body, headers = {}, ca } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      new URL(base + path),
      {
        method,
        ca,
        headers: { ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}), ...headers },
        timeout: 15_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const json = (r) => {
  try {
    return JSON.parse(r.body);
  } catch {
    return null;
  }
};
const compose = (...a) => execFileSync("docker", ["compose", ...a], { cwd: dir, encoding: "utf8", timeout: 60_000 });

try {
  // 1. Caddy issued a private CA and the compose file made its root readable.
  for (let waited = 0; !existsSync(caFile) && waited < 90; waited += 2) await sleep(2000);
  check(existsSync(caFile), `Caddy wrote its CA root at ${caFile}`);
  const ca = readFileSync(caFile);
  const caFingerprint = createHash("sha256").update(ca).digest("hex");

  // 2. The controller answers through Caddy with a certificate from that CA.
  let setup = null;
  for (let i = 0; i < 45 && !setup; i++) {
    try {
      const r = await request("/api/admin/setup", { ca });
      if (r.status === 200) setup = r;
    } catch {
      /* not yet */
    }
    if (!setup) await sleep(2000);
  }
  check(!!setup, `${base}/api/admin/setup answers over TLS signed by the private CA`);
  if (!setup) throw new Error("the controller did not come up behind Caddy");
  check(/max-age=/.test(setup.headers["strict-transport-security"] ?? ""), "HSTS header is set");
  check(json(setup)?.needsSetup === true, "a fresh install asks for first-run setup");

  // 3. The unprivileged controller can read the CA root and serve it to gateways.
  // (The compose file's wrapper opens the file up a couple of seconds after
  // Caddy writes it, so allow for that.)
  let caRes = await request("/ca.crt", { ca });
  for (let i = 0; i < 15 && caRes.status !== 200; i++) {
    await sleep(2000);
    caRes = await request("/ca.crt", { ca });
  }
  check(caRes.status === 200 && caRes.body.trim() === ca.toString("utf8").trim(), `/ca.crt serves the root certificate Caddy wrote (${caRes.status})`);
  const uid = compose("exec", "-T", "controller", "id", "-u").trim();
  check(uid === "1000", `controller runs as uid 1000, not root (got ${uid})`);

  // 4. First-run setup with the code the controller persisted.
  const code = readFileSync(join(dir, "data", "setup-code"), "utf8").trim();
  check(/^[A-Z0-9]{12}$/.test(code), "setup code persisted in the data directory");
  const done = await request("/api/admin/setup", { ca, method: "POST", body: { code, email: "smoke@example.com", password: "deployment smoke test" } });
  check(done.status === 200, `first-run setup succeeds (${done.status} ${done.body.slice(0, 100)})`);
  const setCookie = done.headers["set-cookie"]?.[0] ?? "";
  const cookie = setCookie.split(";")[0];
  check(/;\s*Secure/.test(setCookie), "session cookie is marked Secure");

  // 5. An install command that carries the CA fingerprint, and what the gateway installer downloads.
  const site = json(await request("/api/admin/sites", { ca, method: "POST", body: { name: "Smoke site" }, headers: { cookie } }));
  check(!!site?.id, "site created through the API");
  const tok = json(await request(`/api/admin/sites/${site.id}/enrol-token`, { ca, method: "POST", body: {}, headers: { cookie } }));
  check(tok?.caFingerprint === caFingerprint, "install command carries the CA fingerprint");
  check(
    typeof tok?.command === "string" && tok.command.includes(`curl -fsSL ${base}/install.sh`) && tok.command.includes(`--ca-fingerprint ${caFingerprint}`) && !tok.command.includes("--insecure-http"),
    "install command uses the public URL over https",
  );
  const script = await request("/install.sh", { ca });
  check(script.status === 200 && script.body.includes(`CONTROLLER="${base}"`), "installer is served with the controller URL baked in");
  const sum = await request("/dl/opnmesh-gw-linux-amd64.sha256", { ca });
  check(sum.status === 200 && /^[a-f0-9]{64}/.test(sum.body), "agent binary checksum downloads over TLS (the image ships the agent)");
  const state = json(await request("/api/admin/state", { ca, headers: { cookie } }));
  check(state?.sites?.length === 1, "dashboard state is served to the signed-in admin");
} catch (e) {
  console.error(e);
  failed = true;
}
if (failed) {
  try {
    console.error(compose("logs", "--no-color", "--tail", "60"));
  } catch {
    /* no logs */
  }
  console.error("\nDeployment smoke test FAILED.");
  process.exit(1);
}
console.log("\nDeployment smoke test passed.");
