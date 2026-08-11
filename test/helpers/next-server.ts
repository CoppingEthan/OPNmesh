/**
 * Start and reliably stop a real `next start` for the UI tests.
 *
 * This exists because of a defect that made the UI suite dishonest. The tests
 * spawned next through a shell, so the recorded pid was the shell's; killing it
 * orphaned the actual server, which kept holding the port. The next run then
 * connected to that leftover server — a different build, pointed at a deleted
 * temp directory — and reported results that had nothing to do with the code
 * under test. A security suite that quietly grades the previous binary is worse
 * than no suite, so startup now refuses a port that is already answering, and
 * shutdown kills the whole tree and waits for the port to actually free.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when something is already listening on the port. */
export function portInUse(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPortFree(port: number, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (!(await portInUse(port))) return true;
    await sleep(200);
  }
  return false;
}

export interface RunningServer {
  child: ChildProcess;
  port: number;
}

/**
 * Boot `next start` on `port`. Throws if the port is already taken rather than
 * silently testing whatever is there.
 */
export async function startNextServer(
  port: number,
  env: Record<string, string>,
  readyPath = "/login",
): Promise<RunningServer> {
  if (await portInUse(port)) {
    throw new Error(
      `port ${port} is already in use — refusing to run the UI tests against a server this suite did not start. ` +
        `Stop the process holding it and re-run.`,
    );
  }

  // Spawn node directly on next's CLI: no shell, so `child.pid` is the server
  // itself and the process tree can actually be killed.
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: { ...process.env, ...env },
  });

  let exited: number | null = null;
  child.once("exit", (code) => {
    exited = code ?? -1;
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`next start exited early with code ${exited}`);
    try {
      await fetch(`http://127.0.0.1:${port}${readyPath}`);
      return { child, port };
    } catch {
      await sleep(500);
    }
  }
  await stopNextServer({ child, port });
  throw new Error(`next start did not come up on port ${port} within 90s`);
}

/** Kill the server and its children, and confirm the port is released. */
export async function stopNextServer(server: RunningServer | null): Promise<void> {
  if (!server?.child.pid) return;
  const pid = server.child.pid;
  try {
    if (process.platform === "win32") {
      // /T takes the whole tree; without it next's workers survive.
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    /* already gone */
  }
  if (!(await waitForPortFree(server.port, 15_000))) {
    throw new Error(
      `port ${server.port} is still held after killing pid ${pid}; a later run would test a stale server`,
    );
  }
}
