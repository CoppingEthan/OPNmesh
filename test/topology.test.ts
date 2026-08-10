import { describe, expect, it } from "vitest";
import {
  clientPathTo,
  clientRouteFrom,
  connectivityMatrix,
  nextHop,
  pairStatus,
  spofAnalysis,
  transitVia,
} from "../lib/topology.js";
import { FIXTURES, loadFixture } from "./helpers.js";

describe("full mesh (reference)", () => {
  const cfg = loadFixture("reference");

  it("every pair is direct", () => {
    for (const e of connectivityMatrix(cfg)) {
      expect(e.status).toEqual({ kind: "direct" });
    }
  });

  it("nothing is a transit SPOF", () => {
    for (const r of spofAnalysis(cfg)) {
      expect(r.severedPairs).toEqual([]);
      expect(r.strandedClients).toEqual([]);
    }
  });
});

describe("single hub", () => {
  const cfg = loadFixture("single-hub");

  it("spokes transit the hub", () => {
    expect(pairStatus(cfg, "site-b", "site-c")).toEqual({ kind: "transit", via: "site-a" });
    expect(pairStatus(cfg, "site-a", "site-b")).toEqual({ kind: "direct" });
  });

  it("hub death severs the spoke pair and strands the client", () => {
    const report = spofAnalysis(cfg).find((r) => r.siteId === "site-a")!;
    expect(report.severedPairs).toEqual([["site-b", "site-c"]]);
    expect(report.strandedClients).toEqual(["laptop"]);
  });
});

describe("multi hub", () => {
  const cfg = loadFixture("multi-hub");

  it("capable sites peer directly; the NAT site reaches the non-hub via the first hub", () => {
    expect(pairStatus(cfg, "site-a", "site-c")).toEqual({ kind: "direct" });
    expect(pairStatus(cfg, "site-b", "site-c")).toEqual({ kind: "direct" });
    expect(pairStatus(cfg, "site-d", "site-a")).toEqual({ kind: "direct" });
    expect(pairStatus(cfg, "site-d", "site-b")).toEqual({ kind: "direct" });
    expect(pairStatus(cfg, "site-d", "site-c")).toEqual({ kind: "transit", via: "site-a" });
  });

  it("transit designation is symmetric — both ends pick the same hub", () => {
    expect(transitVia(cfg, "site-d", "site-c")).toBe(transitVia(cfg, "site-c", "site-d"));
  });

  it("losing the first hub severs only the transit pair", () => {
    const a = spofAnalysis(cfg).find((r) => r.siteId === "site-a")!;
    expect(a.severedPairs).toEqual([["site-c", "site-d"]]);
    const b = spofAnalysis(cfg).find((r) => r.siteId === "site-b")!;
    expect(b.severedPairs).toEqual([]);
  });

  it("next hop toward a transit destination is the hub", () => {
    expect(nextHop(cfg, "site-d", "site-c")).toBe("site-a");
    expect(nextHop(cfg, "site-d", "site-b")).toBe("site-b");
  });
});

describe("client routing consistency", () => {
  it("forward and return paths agree for every client and site in every fixture", () => {
    for (const name of FIXTURES) {
      const cfg = loadFixture(name);
      for (const c of cfg.clients) {
        for (const s of cfg.sites) {
          const forward = clientPathTo(cfg, c, s.id);
          const ret = clientRouteFrom(cfg, s.id, c);
          if (c.entryPoints.includes(s.id)) {
            // Entry sites talk to the client directly.
            expect(forward).toBe(s.id);
            expect(ret).toBe("self");
          } else if (forward === null) {
            // Unreachable must be mutual, or return traffic would blackhole.
            expect(ret).toBeNull();
          } else {
            // The gateway must route the client's /32 back toward the same
            // entry point the client used to get there.
            expect(ret).not.toBeNull();
            expect(forward).toBe(c.entryPoints[0]);
          }
        }
      }
    }
  });
});
