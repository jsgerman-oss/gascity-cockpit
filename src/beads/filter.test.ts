import { describe, expect, it } from "vitest";
import { buildBeadTree, filterRecords, groupRecords, sortRecords } from "./filter";
import { DEFAULT_FILTERS, type BeadRecord, type CityNode, type ExplorerData, type GroupNode } from "./types";
import { makeRecord } from "./fixtures";

const NOW = new Date("2026-06-05T00:00:00Z");

function records(): BeadRecord[] {
  return [
    makeRecord({ id: "open-ready", status: "open", priority: 1 }, true),
    makeRecord({ id: "open-blocked", status: "open", priority: 0 }, false),
    makeRecord({ id: "wip", status: "in_progress", assignee: "rigA/agent" }, null),
    makeRecord({ id: "done", status: "closed" }, null),
  ];
}

describe("filterRecords", () => {
  it("hides closed beads by default but keeps them when includeClosed is set", () => {
    expect(filterRecords(records(), DEFAULT_FILTERS, NOW).map((r) => r.bead.id)).not.toContain("done");
    expect(filterRecords(records(), { includeClosed: true }, NOW).map((r) => r.bead.id)).toContain("done");
  });

  it("keeps closed beads when the status filter names them explicitly", () => {
    const out = filterRecords(records(), { includeClosed: false, status: ["closed"] }, NOW);
    expect(out.map((r) => r.bead.id)).toEqual(["done"]);
  });

  it("filters by derived display status", () => {
    const out = filterRecords(records(), { includeClosed: false, status: ["ready"] }, NOW);
    expect(out.map((r) => r.bead.id)).toEqual(["open-ready"]);
  });

  it("filters by rig, assignee, type, and priority", () => {
    expect(filterRecords(records(), { includeClosed: false, assignee: "rigA/agent" }, NOW).map((r) => r.bead.id)).toEqual([
      "wip",
    ]);
    expect(filterRecords(records(), { includeClosed: false, rig: "rigA" }, NOW).map((r) => r.bead.id)).toEqual(["wip"]);
    expect(filterRecords(records(), { includeClosed: false, priority: 0 }, NOW).map((r) => r.bead.id)).toEqual([
      "open-blocked",
    ]);
  });

  it("treats an empty-string assignee filter as 'unassigned'", () => {
    const out = filterRecords(records(), { includeClosed: false, assignee: "" }, NOW);
    expect(out.map((r) => r.bead.id).sort()).toEqual(["open-blocked", "open-ready"]);
  });

  it("matches free text against id and title", () => {
    const recs = [makeRecord({ id: "x-1", title: "Build the explorer" }), makeRecord({ id: "x-2", title: "Other" })];
    expect(filterRecords(recs, { includeClosed: false, text: "explorer" }, NOW).map((r) => r.bead.id)).toEqual(["x-1"]);
    expect(filterRecords(recs, { includeClosed: false, text: "X-2" }, NOW).map((r) => r.bead.id)).toEqual(["x-2"]);
  });
});

describe("groupRecords", () => {
  it("groups by status in actionable order with counts", () => {
    const groups = groupRecords("alpha", filterRecords(records(), { includeClosed: true }, NOW), "status", NOW);
    expect(groups.map((g) => g.key)).toEqual(["in_progress", "ready", "blocked", "closed"]);
    expect(groups.every((g) => g.count === g.children.length)).toBe(true);
  });

  it("groups by priority by rank", () => {
    const groups = groupRecords("alpha", records(), "priority", NOW);
    // P0 (open-blocked), P1 (open-ready), then unset (wip, done) — closed filtered out below
    expect(groups[0].label).toBe("P0 · critical");
    expect(groups[1].label).toBe("P1 · high");
  });

  it("sinks the unassigned group when grouping by assignee", () => {
    const groups = groupRecords("alpha", filterRecords(records(), { includeClosed: false }, NOW), "assignee", NOW);
    const labels = groups.map((g) => g.label);
    expect(labels[labels.length - 1]).toBe("(unassigned)");
  });

  it("gives each group a stable, city-scoped id", () => {
    const groups = groupRecords("alpha", records(), "status", NOW);
    expect(groups[0].id).toMatch(/^group:alpha:status:/);
  });
});

describe("sortRecords", () => {
  it("orders by status, then priority, then id", () => {
    const recs = [
      makeRecord({ id: "b", status: "open" }, true),
      makeRecord({ id: "a", status: "in_progress" }),
      makeRecord({ id: "c", status: "open" }, true),
    ];
    expect(sortRecords(recs, NOW).map((r) => r.bead.id)).toEqual(["a", "b", "c"]);
  });
});

describe("buildBeadTree", () => {
  const spec = { groupBy: "status" as const, filters: { includeClosed: false } };

  function data(): ExplorerData {
    return {
      cities: [
        { city: "alpha", running: true, partial: false, records: records() },
        { city: "beta", running: false, partial: false, records: [] },
        { city: "gamma", running: true, partial: false, records: [], error: "boom" },
      ],
    };
  }

  it("puts a city tier on top, each holding groups", () => {
    const tree = buildBeadTree(data(), spec, NOW) as CityNode[];
    expect(tree.map((c) => c.city)).toEqual(["alpha", "beta", "gamma"]);
    const alpha = tree[0];
    expect(alpha.kind).toBe("city");
    expect(alpha.count).toBe(3); // closed hidden
    expect(alpha.children.some((c) => c.kind === "group")).toBe(true);
  });

  it("represents a stopped city with a message child", () => {
    const beta = (buildBeadTree(data(), spec, NOW) as CityNode[])[1];
    expect(beta.children).toHaveLength(1);
    expect(beta.children[0]).toMatchObject({ kind: "message", label: expect.stringContaining("stopped") });
  });

  it("represents a city load error with a message child", () => {
    const gamma = (buildBeadTree(data(), spec, NOW) as CityNode[])[2];
    expect(gamma.children[0]).toMatchObject({ kind: "message", detail: "boom" });
  });

  it("shows an empty-state message when a running city has no matching beads", () => {
    const empty: ExplorerData = { cities: [{ city: "alpha", running: true, partial: false, records: [] }] };
    const node = (buildBeadTree(empty, spec, NOW) as CityNode[])[0];
    expect(node.children[0]).toMatchObject({ kind: "message", label: "No matching beads" });
  });

  it("collapses an empty dataset to a single message row", () => {
    const tree = buildBeadTree({ cities: [] }, spec, NOW);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: "message", label: "No cities registered" });
  });

  it("nests bead leaves under their group", () => {
    const alpha = (buildBeadTree(data(), spec, NOW) as CityNode[])[0];
    const firstGroup = alpha.children.find((c): c is GroupNode => c.kind === "group")!;
    expect(firstGroup.children[0].kind).toBe("bead");
    expect(firstGroup.children[0].beadId).toBeDefined();
  });
});
