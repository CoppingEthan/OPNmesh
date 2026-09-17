import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getDb } from "@/db";
import { logEvent } from "@/server/events";
import { withAdmin } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * A consistent copy of the database. VACUUM INTO writes a complete snapshot
 * including everything still in the write-ahead log, which copying the file
 * by hand while the controller runs would miss. secret.key is not included:
 * the Backups card tells the admin to keep the two together. The copy is
 * streamed from disk and removed once sent: history can make the database
 * large, and holding it in memory could exhaust the container.
 */
export const GET = withAdmin(async (_req, { admin }) => {
  const dir = mkdtempSync(join(tmpdir(), "opnmesh-backup-"));
  const file = join(dir, "opnmesh.db");
  let streaming = false;
  try {
    getDb().$client.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const size = statSync(file).size;
    const stream = createReadStream(file);
    stream.on("close", () => rmSync(dir, { recursive: true, force: true }));
    streaming = true;
    logEvent("system", "Database backup downloaded", { actor: admin.email });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename="opnmesh-backup-${stamp}.db"`,
        "Cache-Control": "no-store",
      },
    });
  } finally {
    if (!streaming) rmSync(dir, { recursive: true, force: true });
  }
});
