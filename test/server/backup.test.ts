/**
 * Database backups: the copy never outlives the download on disk, one runs at
 * a time, HEAD does nothing, and copies left by a stopped controller are
 * removed at start.
 */
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./helpers";
import { adminHeaders, req } from "./route-helpers";
import { removeStaleBackups } from "@/server/backup";
import { listEvents } from "@/server/events";
import { createSite } from "@/server/sites";
import { GET as backupGet } from "../../app/api/admin/backup/route";

const TEMP_VARS = ["TMPDIR", "TMP", "TEMP"] as const;
let saved: Record<string, string | undefined> = {};
let temp = "";

beforeEach(() => {
  freshDb();
  // A temporary directory of this test's own, so what is left in it can be checked.
  temp = mkdtempSync(join(tmpdir(), "opnmesh-backup-test-"));
  saved = Object.fromEntries(TEMP_VARS.map((k) => [k, process.env[k]]));
  for (const k of TEMP_VARS) process.env[k] = temp;
});
afterEach(() => {
  for (const k of TEMP_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(temp, { recursive: true, force: true });
});

const get = (headers: Record<string, string>, method = "GET") => backupGet(req(method, "/api/admin/backup", undefined, headers));

/** The slot is freed when the descriptor closes, a moment after the download ends. */
async function whenFree(admin: Record<string, string>): Promise<Response> {
  for (let i = 0; i < 100; i++) {
    const r = await get(admin);
    if (r.status !== 409) return r;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the backup slot was never freed");
}

describe("database backup", () => {
  it("streams from a copy that is already gone from disk", async () => {
    const admin = adminHeaders();
    createSite({ name: "DC" });
    const r = await get(admin);
    expect(r.status).toBe(200);
    // Nothing on disk while the download is still to be read.
    expect(readdirSync(temp)).toEqual([]);
    const bytes = Buffer.from(await r.arrayBuffer());
    expect(Number(r.headers.get("content-length"))).toBe(bytes.length);
    const copy = new Database(bytes);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM sites").get() as { n: number }).n).toBe(1);
    copy.close();
    expect(readdirSync(temp)).toEqual([]);
  });

  it("runs one at a time, and a download that is abandoned frees the slot", async () => {
    const admin = adminHeaders();
    const first = await get(admin);
    expect(first.status).toBe(200);
    const busy = await get(admin);
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toMatch(/already being downloaded/);
    await first.body!.cancel();
    const next = await whenFree(admin);
    expect(next.status).toBe(200);
    await next.arrayBuffer();
    const after = await whenFree(admin);
    expect(after.status).toBe(200);
    await after.body!.cancel();
  });

  it("does nothing for HEAD", async () => {
    const admin = adminHeaders();
    const head = await get(admin, "HEAD");
    expect(head.status).toBe(405);
    expect(readdirSync(temp)).toEqual([]);
    expect(listEvents().some((e) => e.message === "Database backup downloaded")).toBe(false);
    // Nor does it hold the slot.
    const r = await whenFree(admin);
    expect(r.status).toBe(200);
    await r.body!.cancel();
  });

  it("is refused to a request another site started", async () => {
    const admin = adminHeaders();
    expect((await get({ ...admin, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(listEvents().some((e) => e.message === "Database backup downloaded")).toBe(false);
  });
});

describe("leftover copies", () => {
  it("are removed at start, and nothing else is", () => {
    for (const name of ["opnmesh-backup-Ab12Cd", "opnmesh-backup-zz9999"]) {
      mkdirSync(join(temp, name));
      writeFileSync(join(temp, name, "opnmesh.db"), "old copy");
    }
    mkdirSync(join(temp, "opnmesh-backup-keep-me"));
    writeFileSync(join(temp, "opnmesh-backup-abcdef"), "a file, not a copy directory");
    writeFileSync(join(temp, "secret.key"), "x");
    expect(removeStaleBackups(temp)).toBe(2);
    expect(readdirSync(temp).sort()).toEqual(["opnmesh-backup-abcdef", "opnmesh-backup-keep-me", "secret.key"]);
    expect(removeStaleBackups(join(temp, "missing"))).toBe(0);
  });
});
