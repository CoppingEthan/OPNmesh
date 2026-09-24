/**
 * Database backups for the admin to download.
 *
 * VACUUM INTO writes a consistent snapshot including everything still in the
 * write-ahead log, which copying the file by hand while the controller runs
 * would miss. The copy goes to a private temporary directory, is opened, and
 * the directory is removed straight away: the download reads from the open
 * descriptor, so nothing is left on disk however the request ends, and the
 * space comes back when the descriptor closes. Each backup holds a full copy
 * of the database until it has been sent, so one runs at a time.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getDb } from "@/db";

const PREFIX = "opnmesh-backup-";
/** What mkdtemp makes from PREFIX: six random letters and digits. */
const TEMP_DIR_RE = /^opnmesh-backup-[A-Za-z0-9]{6}$/;

const g = globalThis as unknown as { __opnmeshBackupBusy?: boolean };

export interface Backup {
  body: ReadableStream<Uint8Array>;
  size: number;
}

/** A snapshot ready to stream, or null while another backup is still being sent. */
export async function openBackup(): Promise<Backup | null> {
  if (g.__opnmeshBackupBusy) return null;
  g.__opnmeshBackupBusy = true;
  const release = () => {
    g.__opnmeshBackupBusy = false;
  };
  let handle: FileHandle | null = null;
  try {
    const dir = mkdtempSync(join(tmpdir(), PREFIX));
    try {
      const file = join(dir, "opnmesh.db");
      getDb().$client.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      handle = await open(file, "r");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const size = (await handle.stat()).size;
    // Closes the descriptor when the download ends or is abandoned.
    const stream = handle.createReadStream();
    stream.on("close", release);
    return { body: Readable.toWeb(stream) as ReadableStream<Uint8Array>, size };
  } catch (e) {
    await handle?.close().catch(() => undefined);
    release();
    throw e;
  }
}

/**
 * Removes copies left behind by a controller that stopped while making a
 * backup (before this version, also by every backup whose download was never
 * read). Called once at start, before any request can be making one.
 */
export function removeStaleBackups(dir = tmpdir()): number {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !TEMP_DIR_RE.test(entry.name)) continue;
    try {
      rmSync(join(dir, entry.name), { recursive: true, force: true });
      removed++;
    } catch (e) {
      console.error(`[opnmesh] could not remove the old backup copy ${join(dir, entry.name)}:`, e);
    }
  }
  if (removed > 0) console.log(`[opnmesh] removed ${removed} leftover backup ${removed === 1 ? "copy" : "copies"} from ${dir}`);
  return removed;
}
