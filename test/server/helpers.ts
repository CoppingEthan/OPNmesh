/** Fresh in-memory database per test file, wired into the process-wide handle. */
import { openDatabase, useDatabase, type Db } from "@/db";
import { setEnvForTests } from "@/server/env";
import { invalidateGenerated } from "@/server/snapshot";
import { liveState } from "@/server/live";
import { resetThrottleForTests } from "@/server/auth";

export function freshDb(): Db {
  process.env["OPNMESH_DATA_DIR"] = process.env["OPNMESH_DATA_DIR"] ?? "./.test-data";
  const db = openDatabase(":memory:");
  useDatabase(db, `:memory:${Math.random()}`);
  setEnvForTests({ secret: "test-secret-" + Math.random(), publicUrl: "http://controller.test", insecureHttp: true, trustProxy: false });
  invalidateGenerated();
  liveState().clearForTests();
  resetThrottleForTests();
  return db;
}
