/**
 * Atomic file write: write a sibling temp file, then rename it over the target.
 *
 * rename(2) is atomic within a filesystem, so a concurrent reader always sees
 * either the whole old file or the whole new one — never a half-written one.
 * sites.yml in particular has two writer processes (the UI and the control
 * server share the state dir) and many readers (every agent config pull, every
 * page load, the 2s tick), and a plain writeFileSync leaves a window where a
 * reader parses a truncated document and 500s. This closes that window. It does
 * NOT serialize the two writers — a lost update under simultaneous writes still
 * needs a lock — but it removes the corruption/torn-read failure mode.
 */
import { writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function writeFileAtomic(path: string, content: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode });
    renameSync(tmp, path);
  } catch (e) {
    // Never leave a stray temp file behind on failure.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw e;
  }
}
