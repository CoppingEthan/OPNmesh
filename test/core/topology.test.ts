import { describe, expect, it } from "vitest";
import {
  clientEntrySites,
  clientRouteFrom,
  connectivityMatrix,
  hubs,
  meshSites,
  pairStatus,
  spofAnalysis,
  transitDestinationsVia,
} from "@/core/topology";
import { scenarios } from "../fixtures/snapshots";

describe("mesh membership", () => {
  it("ignores sites without a gateway", () => {
    const snap = scenarios["pending-site"]!();
    expect(meshSites(snap).map((s) => s.slug)).toEqual(["dc"]);
  });
  it("orders hubs by priority then slug", () => {
    const snap = scenarios["two-spokes"]!();
    expect(hubs(snap).map((s) => s.slug)).toEqual(["dc", "office"]);
  });
});

describe("pair status", () => {
  it("reachable pairs are direct", () => {
    const snap = scenarios["two-sites"]!();
    expect(pairStatus(snap, "site-dc", "site-office")).toEqual({ kind: "direct" });
  });
  it("one reachable side is enough", () => {
    const snap = scenarios["hub-and-spoke"]!();
    expect(pairStatus(snap, "site-office", "site-warehouse")).toEqual({ kind: "direct" });
  });
  it("two outbound-only sites transit the first hub", () => {
    const snap = scenarios["two-spokes"]!();
    expect(pairStatus(snap, "site-shop-north", "site-shop-south")).toEqual({ kind: "transit", via: "site-dc" });
    expect(transitDestinationsVia(snap, "site-shop-north", "site-dc").map((s) => s.slug)).toEqual(["shop-south"]);
    expect(transitDestinationsVia(snap, "site-shop-north", "site-office")).toEqual([]);
  });
  it("no hub means unreachable", () => {
    const snap = scenarios["no-hub"]!();
    expect(connectivityMatrix(snap)).toEqual([{ a: "site-a", b: "site-b", status: { kind: "unreachable" } }]);
  });
});

describe("clients", () => {
  it("enter at every reachable site by default", () => {
    const snap = scenarios["hub-and-spoke"]!();
    const alice = snap.clients[0]!;
    expect(clientEntrySites(snap, alice).map((s) => s.slug)).toEqual(["dc", "office"]);
    expect(clientRouteFrom(snap, "site-dc", alice)).toBe("self");
    // The warehouse is outbound-only; it reaches alice through her relay (dc, the first hub).
    expect(clientRouteFrom(snap, "site-warehouse", alice)).toBe("site-dc");
  });
  it("use the preferred site as relay when it is reachable", () => {
    const snap = scenarios["hub-and-spoke"]!();
    const bob = snap.clients[1]!;
    expect(clientRouteFrom(snap, "site-warehouse", bob)).toBe("site-office");
  });
  it("restricted clients only peer where they carry something", () => {
    const snap = scenarios["policies"]!();
    const contractor = snap.clients.find((c) => c.slug === "contractor")!;
    expect(clientEntrySites(snap, contractor).map((s) => s.slug)).toEqual(["office"]);
    expect(clientRouteFrom(snap, "site-dc", contractor)).toBeNull();
    expect(clientRouteFrom(snap, "site-depot", contractor)).toBeNull();

    const tablet = snap.clients.find((c) => c.slug === "depot-tablet")!;
    // Depot is outbound-only, so the tablet enters at the relay (dc) even though dc itself is not allowed.
    expect(clientEntrySites(snap, tablet).map((s) => s.slug)).toEqual(["dc"]);
    expect(clientRouteFrom(snap, "site-depot", tablet)).toBe("site-dc");
    expect(clientRouteFrom(snap, "site-office", tablet)).toBeNull();
  });
});

describe("single points of failure", () => {
  it("reports what a hub's death severs", () => {
    const snap = scenarios["two-spokes"]!();
    const dc = spofAnalysis(snap).find((r) => r.siteId === "site-dc")!;
    expect(dc.severedPairs).toEqual([["site-shop-north", "site-shop-south"]]);
    expect(dc.relayDependentClients).toEqual(["client-alice-laptop"]);
    const office = spofAnalysis(snap).find((r) => r.siteId === "site-office")!;
    expect(office.severedPairs).toEqual([]);
  });
});
