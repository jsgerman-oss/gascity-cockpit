import { describe, expect, it } from "vitest";
import { accessibleBeadNodeLabel } from "./a11y.ts";
import { makeBead } from "./fixtures.ts";
import type { BeadLeaf, CityNode, GroupNode, MessageNode } from "./types.ts";

describe("accessibleBeadNodeLabel", () => {
  it("describes a running city with a pluralised bead count", () => {
    const node: CityNode = { kind: "city", id: "city:alpha", city: "alpha", running: true, partial: false, count: 3, children: [] };
    expect(accessibleBeadNodeLabel(node)).toBe("City alpha, 3 beads");
  });

  it("uses the singular noun for a one-bead city", () => {
    const node: CityNode = { kind: "city", id: "city:alpha", city: "alpha", running: true, partial: false, count: 1, children: [] };
    expect(accessibleBeadNodeLabel(node)).toBe("City alpha, 1 bead");
  });

  it("flags a truncated city result", () => {
    const node: CityNode = { kind: "city", id: "city:alpha", city: "alpha", running: true, partial: true, count: 50, children: [] };
    expect(accessibleBeadNodeLabel(node)).toBe("City alpha, 50 beads (truncated)");
  });

  it("reports a stopped city without a count", () => {
    const node: CityNode = { kind: "city", id: "city:beta", city: "beta", running: false, partial: false, count: 0, children: [] };
    expect(accessibleBeadNodeLabel(node)).toBe("City beta, stopped");
  });

  it("reports a failed city ahead of its run state", () => {
    const node: CityNode = { kind: "city", id: "city:beta", city: "beta", running: true, partial: false, count: 0, error: "boom", children: [] };
    expect(accessibleBeadNodeLabel(node)).toBe("City beta, failed to load");
  });

  it("describes a group with its count", () => {
    const node: GroupNode = { kind: "group", id: "g", city: "alpha", groupBy: "status", key: "ready", label: "Ready", rank: 0, count: 2, children: [] };
    expect(accessibleBeadNodeLabel(node)).toBe("Ready, 2 beads");
  });

  it("folds a bead's icon-encoded status and priority into words", () => {
    const node: BeadLeaf = {
      kind: "bead",
      id: "bead:alpha:b-1",
      city: "alpha",
      beadId: "b-1",
      record: { city: "alpha", bead: makeBead({ id: "b-1", title: "Wire the thing", priority: 1 }), ready: true },
      displayStatus: "ready",
    };
    const label = accessibleBeadNodeLabel(node);
    expect(label).toContain("b-1");
    expect(label).toContain("Ready");
    expect(label).toContain("Wire the thing");
  });

  it("omits an absent bead title", () => {
    const node: BeadLeaf = {
      kind: "bead",
      id: "bead:alpha:b-2",
      city: "alpha",
      beadId: "b-2",
      record: { city: "alpha", bead: makeBead({ id: "b-2", title: "" }), ready: null },
      displayStatus: "open",
    };
    expect(accessibleBeadNodeLabel(node).endsWith(", ")).toBe(false);
  });

  it("joins a message label with its detail", () => {
    const node: MessageNode = { kind: "message", id: "m", label: "Failed to load beads", detail: "timeout" };
    expect(accessibleBeadNodeLabel(node)).toBe("Failed to load beads: timeout");
  });

  it("returns a bare message label when there is no detail", () => {
    const node: MessageNode = { kind: "message", id: "m", label: "No matching beads" };
    expect(accessibleBeadNodeLabel(node)).toBe("No matching beads");
  });
});
