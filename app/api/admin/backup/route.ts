import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "@/db";
import { logEvent } from "@/server/events";
import { withAdmin } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * A consistent copy of the database. VACUUM INTO writes a complete snapshot
 * including everything still in the write-ahead log, which copying the file
 * by hand while the controller runs would miss. secret.key is not included:
 * the Backups card tells the admin to keep the two together.
 */
export const GET = withAdmin(async (_req, { admin }) => {
  const dir = mkdtempSync(join(tmpdir(), "opnmesh-backup-"));
  const file = join(dir, "opnmesh.db");
  try {
    getDb().$client.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const bytes = readFileSync(file);
    logEvent("system", "Database backup downloaded", { actor: admin.email });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Disposition": `attachment; filename="opnmesh-backup-${stamp}.db"`,
        "Cache-Control": "no-store",
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
