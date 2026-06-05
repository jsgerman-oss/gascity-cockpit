import { describe, expect, it } from "vitest";
import type { Bead, DiffFile } from "./worktree.ts";
import {
  buildActivity,
  buildIndex,
  dedupeTouchedFiles,
  normalizeRepoPath,
  touchDecoration,
  touchDetail,
  touchSummary,
  WorktreeActivityIndex,
  type FileTouch,
  type WorktreeActivity,
} from "./lens.ts";

function bead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: "blackrim-hq.42",
    title: "Some work",
    status: "in_progress",
    issue_type: "task",
    created_at: "2026-06-05T00:00:00Z",
    ...overrides,
  };
}

function diff(path: string, raw = "M"): DiffFile {
  const code = raw.charAt(0).toUpperCase();
  const change =
    code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : "modified";
  return { change, path, raw };
}

function activity(over: Partial<WorktreeActivity> = {}): WorktreeActivity {
  return {
    beadId: "city.1",
    city: "blackrim-hq",
    title: "Work",
    assignee: "gastown.slit",
    rig: "gascity-cockpit",
    workDir: "/work/one",
    files: [{ path: "src/a.ts", change: "modified" }],
    ...over,
  };
}

describe("normalizeRepoPath", () => {
  it("converts backslashes to forward slashes and strips a leading ./", () => {
    expect(normalizeRepoPath("src\\a\\b.ts")).toBe("src/a/b.ts");
    expect(normalizeRepoPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("src/a.ts")).toBe("src/a.ts");
  });
});

describe("dedupeTouchedFiles", () => {
  it("de-duplicates by normalised path, keeping the first change seen", () => {
    const files = [diff("src/a.ts", "A"), diff("./src/a.ts", "M"), diff("src\\b.ts", "M")];
    expect(dedupeTouchedFiles(files)).toEqual([
      { path: "src/a.ts", change: "added" },
      { path: "src/b.ts", change: "modified" },
    ]);
  });

  it("skips entries with an empty path", () => {
    expect(dedupeTouchedFiles([diff("", "M"), diff("src/a.ts", "M")])).toEqual([
      { path: "src/a.ts", change: "modified" },
    ]);
  });
});

describe("buildActivity", () => {
  it("returns null when the bead records no worktree", () => {
    expect(buildActivity(bead(), "blackrim-hq", [diff("src/a.ts")])).toBeNull();
    expect(buildActivity(bead({ metadata: { branch: "feature" } }), "blackrim-hq", [])).toBeNull();
  });

  it("builds the worktree footprint from metadata, city, and changed files", () => {
    const result = buildActivity(
      bead({
        id: "cockpit-21l.3",
        title: "Cost telemetry",
        assignee: "gascity-cockpit/gastown.crew",
        metadata: { work_dir: "/work/tree", branch: "feat", rig: "gascity-cockpit" },
      }),
      "blackrim-hq",
      [diff("src/a.ts", "A"), diff("src/a.ts", "M")],
    );
    expect(result).toEqual({
      beadId: "cockpit-21l.3",
      city: "blackrim-hq",
      title: "Cost telemetry",
      assignee: "gastown.crew",
      rig: "gascity-cockpit",
      workDir: "/work/tree",
      branch: "feat",
      files: [{ path: "src/a.ts", change: "added" }],
    });
  });

  it("omits an absent branch and keeps a non-rig/agent assignee verbatim", () => {
    const result = buildActivity(
      bead({ assignee: "gastown__polecat-bh-wisp", metadata: { work_dir: "/w" } }),
      "blackrim-hq",
      [],
    );
    expect(result?.branch).toBeUndefined();
    expect(result?.assignee).toBe("gastown__polecat-bh-wisp");
  });
});

describe("WorktreeActivityIndex.touching", () => {
  it("returns the worktrees touching a path, sorted by bead id", () => {
    const index = new WorktreeActivityIndex([
      activity({ beadId: "city.2", files: [{ path: "src/shared.ts", change: "modified" }] }),
      activity({ beadId: "city.1", workDir: "/work/two", files: [{ path: "src/shared.ts", change: "added" }] }),
    ]);
    const touches = index.touching("src/shared.ts");
    expect(touches.map((t) => t.beadId)).toEqual(["city.1", "city.2"]);
    expect(touches.map((t) => t.change)).toEqual(["added", "modified"]);
  });

  it("normalises the queried path", () => {
    const index = new WorktreeActivityIndex([activity({ files: [{ path: "src/a.ts", change: "modified" }] })]);
    expect(index.touching("./src/a.ts")).toHaveLength(1);
    expect(index.touching("src\\a.ts")).toHaveLength(1);
  });

  it("returns an empty array for an untouched path", () => {
    const index = new WorktreeActivityIndex([activity()]);
    expect(index.touching("src/other.ts")).toEqual([]);
  });

  it("reports worktree and path counts", () => {
    const index = new WorktreeActivityIndex([
      activity({ beadId: "city.1", files: [{ path: "a.ts", change: "modified" }, { path: "b.ts", change: "added" }] }),
      activity({ beadId: "city.2", workDir: "/work/two", files: [{ path: "a.ts", change: "modified" }] }),
    ]);
    expect(index.worktreeCount).toBe(2);
    expect(index.pathCount).toBe(2);
    expect(index.paths().sort()).toEqual(["a.ts", "b.ts"]);
  });
});

describe("buildIndex", () => {
  it("excludes the worktree at excludeWorkDir (the operator's own checkout)", () => {
    const index = buildIndex(
      [
        activity({ beadId: "self", workDir: "/work/self/", files: [{ path: "src/a.ts", change: "modified" }] }),
        activity({ beadId: "other", workDir: "/work/other", files: [{ path: "src/a.ts", change: "added" }] }),
      ],
      { excludeWorkDir: "/work/self" },
    );
    expect(index.worktreeCount).toBe(1);
    expect(index.touching("src/a.ts").map((t) => t.beadId)).toEqual(["other"]);
  });

  it("keeps every worktree when no exclusion is given", () => {
    expect(buildIndex([activity(), activity({ workDir: "/work/two" })]).worktreeCount).toBe(2);
  });
});

describe("formatting", () => {
  const one: FileTouch = {
    beadId: "cockpit-21l.3",
    city: "blackrim-hq",
    title: "T",
    assignee: "gastown.crew",
    rig: "gascity-cockpit",
    workDir: "/w",
    change: "modified",
  };
  const two: FileTouch = { ...one, beadId: "cockpit-21l.5", assignee: "gastown.slit", change: "added" };

  it("summarises one vs many touches", () => {
    expect(touchSummary([])).toBe("");
    expect(touchSummary([one])).toBe("$(eye) Also editing: cockpit-21l.3 · gastown.crew");
    expect(touchSummary([one, two])).toBe("$(eye) 2 worktrees editing this file");
  });

  it("details each touch with its change kind and rig", () => {
    expect(touchDetail([one, two])).toBe(
      "cockpit-21l.3 · gastown.crew — modified (gascity-cockpit)\ncockpit-21l.5 · gastown.slit — added (gascity-cockpit)",
    );
  });

  it("suppresses a placeholder rig in the detail", () => {
    expect(touchDetail([{ ...one, rig: "(unrouted)" }])).toBe("cockpit-21l.3 · gastown.crew — modified");
  });

  it("builds a decoration badge capped at two characters", () => {
    expect(touchDecoration([])).toBeNull();
    expect(touchDecoration([one])?.badge).toBe("●");
    expect(touchDecoration([one, two])?.badge).toBe("2");
    expect(touchDecoration(Array.from({ length: 12 }, () => one))?.badge).toBe("9+");
    expect(touchDecoration([one])?.tooltip).toContain("Worktree lens — also editing:");
  });
});
