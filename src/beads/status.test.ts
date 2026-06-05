import { describe, expect, it } from "vitest";
import {
  beadAssignee,
  beadRig,
  beadType,
  deriveDisplayStatus,
  displayStatusLabel,
  displayStatusRank,
  priorityLabel,
  priorityRank,
} from "./status";
import { makeRecord } from "./fixtures";

const NOW = new Date("2026-06-05T00:00:00Z");

describe("deriveDisplayStatus", () => {
  it("passes through closed / in_progress / escalated regardless of readiness", () => {
    expect(deriveDisplayStatus(makeRecord({ status: "closed" }, true), NOW)).toBe("closed");
    expect(deriveDisplayStatus(makeRecord({ status: "in_progress" }, false), NOW)).toBe("in_progress");
    expect(deriveDisplayStatus(makeRecord({ status: "in-progress" }), NOW)).toBe("in_progress");
    expect(deriveDisplayStatus(makeRecord({ status: "escalated" }), NOW)).toBe("escalated");
  });

  it("refines an open bead by readiness", () => {
    expect(deriveDisplayStatus(makeRecord({ status: "open" }, true), NOW)).toBe("ready");
    expect(deriveDisplayStatus(makeRecord({ status: "open" }, false), NOW)).toBe("blocked");
    expect(deriveDisplayStatus(makeRecord({ status: "open" }, null), NOW)).toBe("open");
  });

  it("treats an empty raw status as open", () => {
    expect(deriveDisplayStatus(makeRecord({ status: "" }, null), NOW)).toBe("open");
  });

  it("marks a future-dated defer_until on an open bead as deferred", () => {
    const future = makeRecord({ status: "open", defer_until: "2026-06-10T00:00:00Z" }, true);
    expect(deriveDisplayStatus(future, NOW)).toBe("deferred");
  });

  it("ignores a past defer_until", () => {
    const past = makeRecord({ status: "open", defer_until: "2026-06-01T00:00:00Z" }, true);
    expect(deriveDisplayStatus(past, NOW)).toBe("ready");
  });

  it("passes an unknown raw status through, lower-cased", () => {
    expect(deriveDisplayStatus(makeRecord({ status: "PARKED" }), NOW)).toBe("parked");
  });
});

describe("display status labels and ranks", () => {
  it("labels known statuses and title-cases unknown ones", () => {
    expect(displayStatusLabel("in_progress")).toBe("In progress");
    expect(displayStatusLabel("ready")).toBe("Ready");
    expect(displayStatusLabel("parked_late")).toBe("Parked Late");
  });

  it("ranks in_progress ahead of ready ahead of closed; unknown sinks", () => {
    expect(displayStatusRank("in_progress")).toBeLessThan(displayStatusRank("ready"));
    expect(displayStatusRank("ready")).toBeLessThan(displayStatusRank("closed"));
    expect(displayStatusRank("whatever")).toBeGreaterThan(displayStatusRank("closed"));
  });
});

describe("priorityLabel / priorityRank", () => {
  it("labels the canonical priorities", () => {
    expect(priorityLabel(0)).toBe("P0 · critical");
    expect(priorityLabel(1)).toBe("P1 · high");
    expect(priorityLabel(2)).toBe("P2 · normal");
    expect(priorityLabel(3)).toBe("P3 · low");
    expect(priorityLabel(7)).toBe("P7");
    expect(priorityLabel(undefined)).toBe("P— · unset");
  });

  it("ranks lower numbers higher and sinks unset", () => {
    expect(priorityRank(0)).toBeLessThan(priorityRank(3));
    expect(priorityRank(undefined)).toBeGreaterThan(priorityRank(3));
  });
});

describe("beadRig", () => {
  it("prefers explicit metadata.rig", () => {
    expect(beadRig(makeRecord({ metadata: { rig: "myrig", "gc.routed_to": "other/role" } }).bead)).toBe("myrig");
  });

  it("falls back to the rig segment of gc.routed_to", () => {
    expect(beadRig(makeRecord({ metadata: { "gc.routed_to": "gascity-cockpit/gastown.polecat" } }).bead)).toBe(
      "gascity-cockpit",
    );
  });

  it("falls back to the rig segment of a rig/agent assignee", () => {
    expect(beadRig(makeRecord({ assignee: "somerig/agent.x" }).bead)).toBe("somerig");
  });

  it("uses a stable placeholder when nothing routes it", () => {
    expect(beadRig(makeRecord({ assignee: "session-123" }).bead)).toBe("(unrouted)");
  });
});

describe("beadAssignee / beadType placeholders", () => {
  it("labels unassigned and untyped beads", () => {
    expect(beadAssignee(makeRecord({ assignee: "" }).bead)).toBe("(unassigned)");
    expect(beadAssignee(makeRecord({ assignee: "x" }).bead)).toBe("x");
    expect(beadType(makeRecord({ issue_type: "" }).bead)).toBe("(untyped)");
    expect(beadType(makeRecord({ issue_type: "bug" }).bead)).toBe("bug");
  });
});
