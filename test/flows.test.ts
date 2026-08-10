import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlFlowStore, aggregate, type StoredFlow } from "../lib/flows/store.js";

const flow = (over: Partial<StoredFlow>): StoredFlow => ({
  node: "site-a",
  proto: "tcp",
  src: "10.10.5.20",
  dst: "10.30.5.20",
  dstPort: 5201,
  bytes: 1000,
  packets: 10,
  reported: 1000,
  ...over,
});

describe("flow aggregation", () => {
  it("keeps the max of cumulative snapshots for the same flow, not the sum", () => {
    const top = aggregate([flow({ bytes: 1000 }), flow({ bytes: 2500, reported: 1030 })], 0, 10);
    expect(top).toHaveLength(1);
    expect(top[0]!.bytes).toBe(2500);
  });

  it("orders by bytes and respects window + limit", () => {
    const flows = [
      flow({ src: "10.10.5.1", bytes: 100 }),
      flow({ src: "10.10.5.2", bytes: 900 }),
      flow({ src: "10.10.5.3", bytes: 500 }),
      flow({ src: "10.10.5.4", bytes: 9999, reported: 10 }), // outside window
    ];
    const top = aggregate(flows, 500, 2);
    expect(top.map((t) => t.src)).toEqual(["10.10.5.2", "10.10.5.3"]);
  });
});

describe("JsonlFlowStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "opnmesh-flows-"));

  it("ingests, queries, prunes by retention, and purges", () => {
    const store = new JsonlFlowStore(join(dir, "flows.jsonl"));
    store.ingest([flow({ reported: 100 }), flow({ src: "10.20.5.20", reported: 2000 })]);
    expect(store.count()).toBe(2);

    expect(store.topTalkers(0, 10)).toHaveLength(2);
    expect(store.topTalkers(1500, 10)).toHaveLength(1);

    // Retention prune: default window is 7 days, expressed by the caller.
    expect(store.prune(1500)).toBe(1);
    expect(store.count()).toBe(1);

    store.purge();
    expect(store.count()).toBe(0);
  });
});
