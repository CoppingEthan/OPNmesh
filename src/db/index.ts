/**
 * Database handle. One connection per process (cached on globalThis so
 * Next.js dev-mode module reloads do not leak handles). Tests open their own
 * with openDatabase(":memory:") and install it with installDatabaseForTests.
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function migrate(sqlite: Database.Database): number {
  const current = sqlite.pragma("user_version", { simple: true }) as number;
  let applied = 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    sqlite.transaction(() => {
      sqlite.exec(MIGRATIONS[i]!);
      sqlite.pragma(`user_version = ${i + 1}`);
    })();
    applied++;
  }
  return applied;
}

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  migrate(sqlite);
  return drizzle(sqlite, { schema }) as Db;
}

const g = globalThis as unknown as { __opnmeshDb?: Db; __opnmeshDbPath?: string };

/** The process-wide database, opened lazily at the configured path. */
export function getDb(): Db {
  const path = process.env["OPNMESH_DB_PATH"] ?? `${process.env["OPNMESH_DATA_DIR"] ?? "./data"}/opnmesh.db`;
  if (!g.__opnmeshDb || g.__opnmeshDbPath !== path) {
    g.__opnmeshDb = openDatabase(path);
    g.__opnmeshDbPath = path;
  }
  return g.__opnmeshDb;
}

/** Tests: point the process-wide handle at a fresh database. */
export function installDatabaseForTests(db: Db, path = ":test:"): void {
  g.__opnmeshDb = db;
  g.__opnmeshDbPath = path;
  process.env["OPNMESH_DB_PATH"] = path;
}

export { schema };
