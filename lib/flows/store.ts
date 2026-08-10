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

/** JSONL-backed store for the dev server and simulation. */
export class JsonlFlowStore implements FlowStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private readAll(): StoredFlow[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredFlow);
  }

  ingest(flows: StoredFlow[]): void {
    if (flows.length === 0) return;
    appendFileSync(this.path, flows.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
  }

  topTalkers(sinceUnixSec: number, limit: number): TopTalker[] {
    return aggregate(this.readAll(), sinceUnixSec, limit);
  }

  prune(cutoffUnixSec: number): number {
    const all = this.readAll();
    const kept = all.filter((f) => f.reported >= cutoffUnixSec);
    if (kept.length !== all.length) {
      writeFileSync(this.path, kept.map((f) => JSON.stringify(f)).join("\n") + (kept.length ? "\n" : ""), "utf8");
    }
    return all.length - kept.length;
  }

  purge(): void {
    writeFileSync(this.path, "", "utf8");
  }

  count(): number {
    return this.readAll().length;
  }
}
