/**
 * Stopping on SIGTERM: jobs stop, live streams end (so the HTTP server can
 * close), the database is checkpointed and closed, and the process exits
 * with success even if something still holds it open.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";
import { adminHeaders } from "./route-helpers";
import { getDb } from "@/db";
import { startBackgroundJobs } from "@/server/jobs";
import { afterExit, beginShutdown, onShutdown, resetShutdownForTests, SHUTDOWN_DEADLINE_MS, stopping } from "@/server/shutdown";
import { GET as liveGet } from "../../app/api/admin/live/route";

beforeEach(() => {
  freshDb();
  resetShutdownForTests();
});
afterEach(() => {
  resetShutdownForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const liveReq = (cookie: string) => new Request("http://controller.test/api/admin/live", { headers: { cookie, host: "controller.test" } });

describe("stopping", () => {
  it("stops every job at once and exits with success by the deadline", () => {
    // The start-up sweep for old backup copies looks in the temporary directory: give it one of its own.
    const temp = mkdtempSync(join(tmpdir(), "opnmesh-shutdown-test-"));
    const vars = ["TMPDIR", "TMP", "TEMP"] as const;
    const savedTmp = vars.map((k) => process.env[k]);
    for (const k of vars) process.env[k] = temp;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      startBackgroundJobs();
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(6);
      const exit = vi.fn();
      beginShutdown("SIGTERM", exit);
      expect(stopping()).toBe(true);
      expect(vi.getTimerCount()).toBe(1); // only the deadline is left
      vi.advanceTimersByTime(SHUTDOWN_DEADLINE_MS - 1);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(0);
      expect(getDb().$client.open).toBe(false);
      // A second signal changes nothing.
      beginShutdown("SIGINT", exit);
      vi.advanceTimersByTime(SHUTDOWN_DEADLINE_MS);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vars.forEach((k, i) => {
        if (savedTmp[i] === undefined) delete process.env[k];
        else process.env[k] = savedTmp[i];
      });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("ends open live streams, and refuses new ones", async () => {
    const admin = adminHeaders();
    const res = await liveGet(liveReq(admin.cookie!));
    expect(res.status).toBe(200);
    // Its connection closes with it rather than idling, which would hold a stopping server open.
    expect(res.headers.get("connection")).toBe("close");
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("retry:");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    beginShutdown("SIGTERM", vi.fn());
    let done = false;
    for (let i = 0; i < 5 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
    expect((await liveGet(liveReq(admin.cookie!))).status).toBe(503);
  });

  it("runs every hook even when one fails, and forgets a cancelled one", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ran: string[] = [];
    onShutdown(() => {
      throw new Error("boom");
    });
    const cancel = onShutdown(() => ran.push("cancelled"));
    onShutdown(() => ran.push("second"));
    cancel();
    beginShutdown("SIGTERM", vi.fn());
    expect(ran).toEqual(["second"]);
  });

  it("closes the database cleanly on the way out, and reports a requested stop as a success", () => {
    const saved = process.exitCode;
    try {
      afterExit(0);
      expect(getDb().$client.open).toBe(false);
      afterExit(1); // closing twice is harmless
      freshDb();
      afterExit(143); // Next's exit code after SIGTERM, but no stop was asked for: left alone
      expect(process.exitCode).toBe(saved);
      freshDb();
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      beginShutdown("SIGTERM", vi.fn());
      afterExit(143);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = saved;
    }
  });
});
