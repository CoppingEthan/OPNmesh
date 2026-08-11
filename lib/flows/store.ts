/**
 * Tier-3 flow record store (§13). Per-host flows NEVER go to Prometheus —
 * unbounded cardinality would destroy it. They land here instead, with a
 * configurable retention window (default 7 days) and a purge action.
 *
 * The store is an interface so the dev server can use a JSONL file while the
 * production control node uses better-sqlite3 — same semantics, same tests.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredFlow {
  node: string;
  proto: string;
  src: string;
  dst: string;
  dstPort: number;
  bytes: number;
  packets: number;
  /** Unix seconds when the agent reported it. */
  reported: number;
}

export interface TopTalker {
  src: string;
  dst: string;
  proto: string;
  dstPort: number;
  bytes: number;
  packets: number;
}

export interface FlowStore {
  ingest(flows: StoredFlow[]): void;
  /** Aggregated top flows within the window, largest first. */
  topTalkers(sinceUnixSec: number, limit: number): TopTalker[];
  /** Drop records older than the retention cutoff. */
  prune(cutoffUnixSec: number): number;
  /** Delete everything (the §13 purge action). */
  purge(): void;
  count(): number;
}

export function aggregate(flows: StoredFlow[], sinceUnixSec: number, limit: number): TopTalker[] {
  const byKey = new Map<string, TopTalker>();
  for (const f of flows) {
    if (f.reported < sinceUnixSec) continue;
    const key = `${f.src}|${f.dst}|${f.proto}|${f.dstPort}`;
    const cur = byKey.get(key);
    if (cur) {
      // Conntrack counters are cumulative per connection; keep the max seen
      // rather than summing snapshots of the same flow.
      cur.bytes = Math.max(cur.bytes, f.bytes);
      cur.packets = Math.max(cur.packets, f.packets);
    } else {
      byKey.set(key, {
        src: f.src,
        dst: f.dst,
        proto: f.proto,
        dstPort: f.dstPort,
        bytes: f.bytes,
        packets: f.packets,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

/**
 * JSONL-backed store for the dev server, simulation, and single-node
 * deployments.
 *
 * Hardened against a flow-flood DoS: an authenticated node can post up to 5000
 * flows per request, and the naive version read and JSON-parsed the ENTIRE
 * file on every count()/topTalkers()/prune() — so a single node token could
 * grow the file unbounded and freeze the single-threaded control-plane event
 * loop for seconds per synchronous slurp, stalling config pulls for the whole
 * mesh. Three guards fix that here:
 *  - a HARD RECORD CAP bounds the file, so every read is bounded too;
 *  - count() is served from an in-memory counter, so /metrics scrapes and the
 *    like never touch the disk;
 *  - callers clamp the `reported` timestamp before ingest (see the control
 *    server) so a far-future value cannot dodge retention pruning forever.
 * A SQLite-backed store (indexed prune/aggregate/count, no full read) remains
 * the right choice at large scale; this keeps the file store safe until then.
 */
export const DEFAULT_MAX_FLOW_RECORDS = 200_000;

export class JsonlFlowStore implements FlowStore {
  private readonly maxRecords: number;
  /** In-memory record count; null until first established from disk. */
  private cachedCount: number | null = null;
  /**
   * Oldest `reported` timestamp currently stored, or null when unknown/empty.
   * Lets prune() skip reading the whole file when nothing is old enough to
   * drop — the common steady state, where the file is well inside the
   * retention window and the 60s prune would otherwise read it just to delete
   * zero records (the residual event-loop hitch flagged in the audit).
   */
  private oldestReported: number | null = null;
  private established = false;
  private capWarned = false;

  constructor(private readonly path: string, maxRecords: number = DEFAULT_MAX_FLOW_RECORDS) {
    mkdirSync(dirname(path), { recursive: true });
    this.maxRecords = maxRecords;
  }

  private readAll(): StoredFlow[] {
    if (!existsSync(this.path)) return [];
    const flows: StoredFlow[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line) continue;
      // A truncated final line (crash mid-append) must not throw and take the
      // whole endpoint down with it.
      try {
        flows.push(JSON.parse(line) as StoredFlow);
      } catch {
        /* skip corrupt trailing record */
      }
    }
    return flows;
  }

  /** Smallest `reported` in a list, or null if empty. Loop, not Math.min(...spread),
   * which overflows the argument limit at hundreds of thousands of records. */
  private static minReported(flows: StoredFlow[]): number | null {
    if (flows.length === 0) return null;
    let min = flows[0]!.reported;
    for (let i = 1; i < flows.length; i++) if (flows[i]!.reported < min) min = flows[i]!.reported;
    return min;
  }

  /** One-time read to seed the in-memory count and oldest-timestamp watermark. */
  private establish(): void {
    if (this.established) return;
    const all = this.readAll();
    this.cachedCount = all.length;
    this.oldestReported = JsonlFlowStore.minReported(all);
    this.established = true;
  }

  private currentCount(): number {
    this.establish();
    return this.cachedCount!;
  }

  ingest(flows: StoredFlow[]): void {
    if (flows.length === 0) return;
    const have = this.currentCount();
    const room = this.maxRecords - have;
    if (room <= 0) {
      if (!this.capWarned) {
        console.warn(
          `flow store at capacity (${this.maxRecords} records) — dropping new flows until retention prunes older ones`,
        );
        this.capWarned = true;
      }
      return;
    }
    // Never let one flood exceed the cap in a single append.
    const accepted = flows.length > room ? flows.slice(0, room) : flows;
    appendFileSync(this.path, accepted.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
    this.cachedCount = have + accepted.length;
    for (const f of accepted) {
      if (this.oldestReported === null || f.reported < this.oldestReported) this.oldestReported = f.reported;
    }
  }

  topTalkers(sinceUnixSec: number, limit: number): TopTalker[] {
    return aggregate(this.readAll(), sinceUnixSec, limit);
  }

  prune(cutoffUnixSec: number): number {
    this.establish();
    // Nothing is old enough to drop — skip the full-file read entirely. This
    // is the steady state within the retention window.
    if (this.oldestReported === null || this.oldestReported >= cutoffUnixSec) return 0;
    const all = this.readAll();
    const kept = all.filter((f) => f.reported >= cutoffUnixSec);
    if (kept.length !== all.length) {
      writeFileSync(this.path, kept.map((f) => JSON.stringify(f)).join("\n") + (kept.length ? "\n" : ""), "utf8");
    }
    this.cachedCount = kept.length;
    this.oldestReported = JsonlFlowStore.minReported(kept);
    this.capWarned = false;
    return all.length - kept.length;
  }

  purge(): void {
    writeFileSync(this.path, "", "utf8");
    this.oldestReported = null;
    this.established = true;
    this.cachedCount = 0;
    this.capWarned = false;
  }

  count(): number {
    return this.currentCount();
  }
}
