import { openBackup } from "@/server/backup";
import { logEvent } from "@/server/events";
import { json, withAdmin } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * A consistent copy of the database (see src/server/backup.ts). secret.key
 * is not included: the Backups card tells the admin to keep the two
 * together. The copy is streamed rather than held in memory: history can
 * make the database large, and buffering it could exhaust the container.
 */
export const GET = withAdmin(async (_req, { admin }) => {
  const backup = await openBackup();
  if (!backup) return json({ error: "a backup is already being downloaded; try again when it has finished" }, 409);
  try {
    logEvent("system", "Database backup downloaded", { actor: admin.email });
  } catch (e) {
    await backup.body.cancel(); // closes the copy and frees the slot
    throw e;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return new Response(backup.body, {
    headers: {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Length": String(backup.size),
      "Content-Disposition": `attachment; filename="opnmesh-backup-${stamp}.db"`,
      "Cache-Control": "no-store",
    },
  });
});
