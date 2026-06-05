import { describe, expect, it } from "vitest";
import type { FormulaDetail, FormulaRuns } from "../api/formulas";
import {
  formatFormulaDetailMarkdown,
  formatRunsMarkdown,
  relativeTime,
  runState,
  runStateLabel,
  sortRunsNewestFirst,
} from "./format.ts";

const DETAIL: FormulaDetail = {
  name: "tdd",
  description: "Red-green-refactor on a bead",
  deps: [],
  steps: [
    { id: "red", kind: "step", title: "Write a failing test", assignee: "pool" },
    { id: "green", kind: "step", title: "Make it pass", labels: ["impl"] },
  ],
  var_defs: [
    { name: "bead", type: "string", required: true, description: "Bead to work" },
    { name: "mode", type: "string", required: false, default: "strict", enum: ["strict", "loose"] },
  ],
  preview: {
    nodes: [
      { id: "red", kind: "step", title: "Write a failing test" },
      { id: "green", kind: "step", title: "Make it pass" },
    ],
    edges: [{ from: "red", to: "green", kind: "blocks" }],
  },
};

describe("runState", () => {
  it("normalises common status strings", () => {
    expect(runState("running")).toBe("running");
    expect(runState("in_progress")).toBe("running");
    expect(runState("completed")).toBe("done");
    expect(runState("merged")).toBe("done");
    expect(runState("failed")).toBe("failed");
    expect(runState("error")).toBe("failed");
    expect(runState("pending")).toBe("pending");
    expect(runState("queued")).toBe("pending");
  });

  it("returns unknown for empty or unrecognised statuses", () => {
    expect(runState(undefined)).toBe("unknown");
    expect(runState("")).toBe("unknown");
    expect(runState("banana")).toBe("unknown");
  });

  it("prioritises failure over other matches", () => {
    expect(runState("run-failed")).toBe("failed");
  });

  it("labels each state", () => {
    expect(runStateLabel(runState("running"))).toBe("Running");
    expect(runStateLabel(runState("nope"))).toBe("Unknown");
  });
});

describe("formatFormulaDetailMarkdown", () => {
  it("renders heading, target, variables, steps, and the compiled graph", () => {
    const md = formatFormulaDetailMarkdown(DETAIL, "gascity-cockpit/gastown.polecat");
    expect(md).toContain("# Formula: tdd");
    expect(md).toContain("Compiled for **gascity-cockpit/gastown.polecat**.");
    expect(md).toContain("Red-green-refactor on a bead");
    expect(md).toContain("## Variables");
    expect(md).toContain("`bead`");
    expect(md).toContain("one of `strict`, `loose`");
    expect(md).toContain("## Steps");
    expect(md).toContain("**Write a failing test** `red`");
    expect(md).toContain("→ `pool`");
    expect(md).toContain("## Compiled graph");
    expect(md).toContain("```mermaid");
    expect(md).toContain("red -->|blocks| green");
    expect(md).toContain("- `red` → `green` (blocks)");
  });

  it("handles an empty formula gracefully", () => {
    const empty: FormulaDetail = {
      name: "noop",
      description: "",
      deps: [],
      steps: [],
      var_defs: [],
      preview: { nodes: [], edges: [] },
    };
    const md = formatFormulaDetailMarkdown(empty);
    expect(md).toContain("# Formula: noop");
    expect(md).toContain("_No description._");
    expect(md).toContain("_No steps._");
    expect(md).toContain("_The compiled preview is empty._");
    expect(md).not.toContain("Compiled for");
  });
});

describe("formatRunsMarkdown", () => {
  const now = new Date("2026-06-05T01:00:00Z");

  it("renders a runs table with normalised state and relative times", () => {
    const runs: FormulaRuns = {
      formula: "tdd",
      partial: false,
      run_count: 2,
      recent_runs: [
        {
          workflow_id: "wf-old",
          status: "completed",
          target: "pool",
          started_at: "2026-06-05T00:00:00Z",
          updated_at: "2026-06-05T00:10:00Z",
        },
        {
          workflow_id: "wf-new",
          status: "running",
          target: "pool",
          started_at: "2026-06-05T00:55:00Z",
          updated_at: "2026-06-05T00:58:00Z",
        },
      ],
    };
    const md = formatRunsMarkdown(runs, now);
    expect(md).toContain("# Runs: tdd");
    expect(md).toContain("**2** total run(s).");
    // Newest run first.
    expect(md.indexOf("wf-new")).toBeLessThan(md.indexOf("wf-old"));
    expect(md).toContain("Running");
    expect(md).toContain("Done");
    expect(md).toContain("5m ago");
  });

  it("shows an empty state and flags truncation + warnings", () => {
    const md = formatRunsMarkdown(
      { formula: "tdd", partial: true, run_count: 0, recent_runs: [], partial_errors: ["rig x offline"] },
      now,
    );
    expect(md).toContain("_No runs yet.");
    expect(md).toContain("_(list truncated)_");
    expect(md).toContain("## Warnings");
    expect(md).toContain("rig x offline");
  });
});

describe("sortRunsNewestFirst / relativeTime", () => {
  it("orders by started_at descending without mutating the input", () => {
    const input = [
      { workflow_id: "a", status: "done", target: "p", started_at: "2026-06-01T00:00:00Z", updated_at: "" },
      { workflow_id: "b", status: "done", target: "p", started_at: "2026-06-03T00:00:00Z", updated_at: "" },
    ];
    const sorted = sortRunsNewestFirst(input);
    expect(sorted.map((r) => r.workflow_id)).toEqual(["b", "a"]);
    expect(input.map((r) => r.workflow_id)).toEqual(["a", "b"]);
  });

  it("formats coarse relative times and tolerates bad input", () => {
    const now = new Date("2026-06-05T12:00:00Z");
    expect(relativeTime("2026-06-05T11:59:30Z", now)).toBe("30s ago");
    expect(relativeTime("2026-06-05T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-06-05T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-06-02T12:00:00Z", now)).toBe("3d ago");
    expect(relativeTime("2026-06-05T12:00:30Z", now)).toBe("just now");
    expect(relativeTime(undefined, now)).toBe("—");
    expect(relativeTime("not-a-date", now)).toBe("`not-a-date`");
  });
});
