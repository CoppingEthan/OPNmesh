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
 * Root is needed to read data/setup-code, which the controller writes for its
 * own user alone.
 *
 * With --gateway-test (CI) it also makes this host a gateway with the install
 * command the controller prints, under systemd; upgrades it in place; checks
 * that a used token is refused without side effects and that the tunnel
 * comes back from disk with the agent stopped; then removes it all again. The
 * controller's own containers keep working throughout, which proves the
 * gateway firewall leaves container bridges alone. Disposable machines only.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const dir = opt("--dir", "/opt/opnmesh");
const gatewayTest = args.includes("--gateway-test");
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
function sh(cmd, timeout = 300_000) {
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", timeout });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const unit = (name, prop) => sh(`systemctl show -p ${prop} --value ${name}`).out.trim();
const lastLines = (text) => "\n" + text.trim().split("\n").slice(-15).join("\n");
const removeGateway = () =>
  sh(
    "systemctl disable --now opnmesh-gw opnmesh-wg 2>/dev/null; ip link del opnmesh0 2>/dev/null; nft delete table inet opnmesh 2>/dev/null; " +
      "rm -f /etc/systemd/system/opnmesh-gw.service /etc/systemd/system/opnmesh-wg.service; systemctl daemon-reload; " +
      "rm -rf /etc/opnmesh /var/lib/opnmesh /usr/local/bin/opnmesh-gw",
  );

try {
  // 1. Caddy issued a private CA and the compose file made its root readable.
  for (let waited = 0; !existsSync(caFile) && waited < 90; waited += 2) await sleep(2000);
  check(existsSync(caFile), `Caddy wrote its CA root at ${caFile}`);
  const ca = readFileSync(caFile);
  // The standard certificate fingerprint: what a browser shows for the root, without colons.
  const caFingerprint = new X509Certificate(ca).fingerprint256.replace(/:/g, "").toLowerCase();

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
    typeof tok?.command === "string" &&
      tok.command.includes(`${base}/install.sh`) &&
      tok.command.includes(`echo "${tok.installScriptSha256}  $f" | sha256sum -c`) &&
      tok.command.includes(`--ca-fingerprint ${caFingerprint}`) &&
      !tok.command.includes("| sudo bash") &&
      !tok.command.includes("--insecure-http"),
    "install command checks the installer's checksum before running it, then pins the CA",
  );
  const script = await request("/install.sh", { ca });
  check(script.status === 200 && script.body.includes(`CONTROLLER="${base}"`), "installer is served with the controller URL baked in");
  const sum = await request("/dl/opnmesh-gw-linux-amd64.sha256", { ca });
  check(sum.status === 200 && /^[a-f0-9]{64}/.test(sum.body), "agent binary checksum downloads over TLS (the image ships the agent)");
  const state = json(await request("/api/admin/state", { ca, headers: { cookie } }));
  check(state?.sites?.length === 1, "dashboard state is served to the signed-in admin");

  // 5b. The containers' hardening, the data directory's mode, the CSP and the body limit.
  for (const svc of ["controller", "caddy"]) {
    const id = compose("ps", "-q", svc).trim();
    const host = JSON.parse(execFileSync("docker", ["inspect", "-f", "{{json .HostConfig}}", id], { encoding: "utf8" }));
    check(host.ReadonlyRootfs === true && host.CapDrop?.includes("ALL") && host.SecurityOpt?.includes("no-new-privileges:true") && host.Memory > 0 && host.PidsLimit > 0, `${svc} runs read-only, without capabilities or new privileges, with memory and process limits`);
  }
  const capBnd = compose("exec", "-T", "controller", "grep", "CapBnd", "/proc/self/status");
  check(/CapBnd:\s*0+\s*$/.test(capBnd), "the controller's capability bounding set is empty");
  const write = spawnSync("docker", ["compose", "exec", "-T", "controller", "sh", "-c", "touch /app/smoke 2>&1; touch /data/.smoke /app/.next/cache/smoke && rm /data/.smoke /app/.next/cache/smoke && echo writable"], { cwd: dir, encoding: "utf8" });
  check(/read-only file system/i.test(write.stdout) && /writable/.test(write.stdout), "the controller can write to /data and its cache, not to the image");
  check((statSync(join(dir, "data")).mode & 0o777) === 0o700, "the data directory is closed to other users (0700)");
  const csp = String((await request("/login", { ca })).headers["content-security-policy"] ?? "");
  check(/default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/unsafe-eval/.test(csp), "pages carry the production Content-Security-Policy");
  const big = await request("/api/admin/login", { ca, method: "POST", body: { email: "x".repeat(1_200_000), password: "x" } }).catch((e) => ({ status: 0, body: String(e) }));
  check(big.status === 413, `a request body over 1 MiB is refused (${big.status})`);
  const logs = compose("logs", "--no-color", "controller");
  check(!/EROFS|read-only file system|EACCES/i.test(logs), "the controller logged no write errors");

  if (gatewayTest) {
    const gatewayWhere = async (want) => {
      for (let i = 0; i < 60; i++) {
        const st = json(await request("/api/admin/state", { ca, headers: { cookie } }));
        const g = st?.sites?.find((x) => x.id === site.id)?.gateway ?? null;
        if (g && want(g)) return g;
        await sleep(2000);
      }
      return null;
    };

    // 6. A real gateway on this host, from the printed command, under systemd.
    const r1 = sh(tok.command);
    check(r1.code === 0, `the printed install command enrols this host (exit ${r1.code})${r1.code ? lastLines(r1.out) : ""}`);
    const g1 = await gatewayWhere((g) => g.health === "online" && g.configCurrent);
    check(!!g1, "gateway reports online with its configuration applied");
    check(unit("opnmesh-gw", "ActiveState") === "active" && unit("opnmesh-wg", "ActiveState") === "active", "opnmesh-gw and opnmesh-wg run under systemd");
    check(sh("ip link show opnmesh0").code === 0, "tunnel interface opnmesh0 exists");
    check(json(await request("/api/admin/setup", { ca }))?.needsSetup === false, "the controller's containers are still reachable with the gateway firewall loaded");
    const pid1 = unit("opnmesh-gw", "MainPID");

    // 7. Upgrade in place: no token, same identity, agent restarted.
    const up = json(await request("/api/admin/agent-update", { ca, headers: { cookie } }));
    check(typeof up?.command === "string" && up.command.includes("--upgrade") && !up.command.includes("--token"), "the controller offers an upgrade command without a token");
    const r2 = sh(up.command);
    check(r2.code === 0 && /agent updated/.test(r2.out), `the upgrade command updates the agent (exit ${r2.code})${r2.code ? lastLines(r2.out) : ""}`);
    const pid2 = unit("opnmesh-gw", "MainPID");
    check(pid2 !== pid1 && unit("opnmesh-gw", "ActiveState") === "active", `the agent restarted on the new binary (pid ${pid1} -> ${pid2})`);
    const g2 = await gatewayWhere((g) => g.health === "online" && g.lastSeenAt > (g1?.lastSeenAt ?? 0));
    check(!!g2 && g2.gatewayId === g1?.gatewayId && g2.publicKey === g1?.publicKey, "the gateway kept its identity and key through the upgrade");

    // 8. Re-running the used install command fails before changing anything.
    const before = statSync("/usr/local/bin/opnmesh-gw").mtimeMs;
    const r3 = sh(tok.command);
    check(r3.code !== 0 && /enrolment failed/.test(r3.out), "re-running the install command with its used token is refused");
    check(statSync("/usr/local/bin/opnmesh-gw").mtimeMs === before && unit("opnmesh-gw", "MainPID") === pid2, "the installed agent was left untouched and running");

    // 9. Boot path: opnmesh-wg alone brings the tunnel up from the files on disk.
    sh("systemctl stop opnmesh-gw opnmesh-wg");
    check(sh("ip link show opnmesh0").code !== 0, "stopping opnmesh-wg takes the tunnel down");
    sh("systemctl start opnmesh-wg");
    check(sh("ip link show opnmesh0").code === 0, "opnmesh-wg brings the tunnel back from disk with no agent running");
    sh("systemctl start opnmesh-gw");
    const g3 = await gatewayWhere((g) => g.health === "online" && g.lastSeenAt > (g2?.lastSeenAt ?? 0));
    check(!!g3, "the agent reports again after the restart");
  }
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  if (gatewayTest) removeGateway();
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
