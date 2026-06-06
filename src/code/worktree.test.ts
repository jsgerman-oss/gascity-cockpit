import { describe, expect, it } from "vitest";
import {
  changeBadge,
  changeLabel,
  committedRange,
  DEFAULT_TARGET_BRANCH,
  nameStatusArgs,
  parseNameStatus,
  resolveWorktree,
  summarizeDiff,
  summaryLine,
  unifiedDiffArgs,
  workingRange,
  type Bead,
} from "./worktree.ts";

function bead(metadata?: Record<string, string>): Bead {
  return {
    id: "blackrim-hq.42",
    title: "Some work",
    status: "in_progress",
    issue_type: "task",
    created_at: "2026-06-05T00:00:00Z",
    ...(metadata ? { metadata } : {}),
  };
}

describe("resolveWorktree", () => {
  it("returns null when no work_dir is recorded", () => {
    expect(resolveWorktree(bead())).toBeNull();
    expect(resolveWorktree(bead({ branch: "feature" }))).toBeNull();
    expect(resolveWorktree(bead({ work_dir: "   " }))).toBeNull();
  });

  it("resolves work_dir, branch, and target from metadata", () => {
    const ref = resolveWorktree(
      bead({ work_dir: "/work/tree", branch: "gc-furiosa-abc", target: "develop" }),
    );
    expect(ref).toEqual({ workDir: "/work/tree", branch: "gc-furiosa-abc", target: "develop" });
  });

  it("defaults target to main and omits an absent branch", () => {
    const ref = resolveWorktree(bead({ work_dir: "/work/tree" }));
    expect(ref).toEqual({ workDir: "/work/tree", target: DEFAULT_TARGET_BRANCH });
    expect(ref?.branch).toBeUndefined();
  });

  it("trims surrounding whitespace on each field", () => {
    const ref = resolveWorktree(bead({ work_dir: " /w ", branch: " b ", target: " t " }));
    expect(ref).toEqual({ workDir: "/w", branch: "b", target: "t" });
  });
});

describe("diff ranges and args", () => {
  it("committedRange is the three-dot PR range against the target", () => {
    expect(committedRange({ workDir: "/w", branch: "b", target: "main" })).toBe("main...HEAD");
    expect(committedRange({ workDir: "/w", target: "develop" })).toBe("develop...HEAD");
  });

  it("workingRange falls back to the working tree vs HEAD", () => {
    expect(workingRange()).toBe("HEAD");
  });

  it("unifiedDiffArgs builds a diff command, scoping to paths when given", () => {
    expect(unifiedDiffArgs("main...HEAD")).toEqual(["diff", "main...HEAD"]);
    expect(unifiedDiffArgs("main...HEAD", ["src/a.ts", "src/b.ts"])).toEqual([
      "diff",
      "main...HEAD",
      "--",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("nameStatusArgs requests the machine-readable name+status list", () => {
    expect(nameStatusArgs("main...HEAD")).toEqual(["diff", "--name-status", "main...HEAD"]);
  });
});

describe("parseNameStatus", () => {
  it("parses adds, modifies, and deletes", () => {
    const out = "A\tsrc/new.ts\nM\tsrc/changed.ts\nD\tsrc/gone.ts\n";
    expect(parseNameStatus(out)).toEqual([
      { change: "added", path: "src/new.ts", raw: "A" },
      { change: "modified", path: "src/changed.ts", raw: "M" },
      { change: "deleted", path: "src/gone.ts", raw: "D" },
    ]);
  });

  it("parses renames and copies with their old path", () => {
    const out = "R100\told/name.ts\tnew/name.ts\nC075\tsrc/base.ts\tsrc/copy.ts\n";
    expect(parseNameStatus(out)).toEqual([
      { change: "renamed", oldPath: "old/name.ts", path: "new/name.ts", raw: "R100" },
      { change: "copied", oldPath: "src/base.ts", path: "src/copy.ts", raw: "C075" },
    ]);
  });

  it("skips blank lines and tolerates CRLF", () => {
    expect(parseNameStatus("\r\nA\tx.ts\r\n\n")).toEqual([{ change: "added", path: "x.ts", raw: "A" }]);
  });

  it("maps unknown status codes to 'unknown'", () => {
    expect(parseNameStatus("X\tweird.ts")).toEqual([{ change: "unknown", path: "weird.ts", raw: "X" }]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("summarizeDiff / summaryLine", () => {
  it("tallies change kinds, folding copies into renamed", () => {
    const files = parseNameStatus(
      "A\ta\nA\tb\nM\tc\nD\td\nR100\to\tn\nC100\tx\ty\nT\tz\n",
    );
    expect(summarizeDiff(files)).toEqual({
      total: 7,
      added: 2,
      modified: 1,
      deleted: 1,
      renamed: 2,
      other: 1,
    });
  });

  it("renders a compact summary line", () => {
    expect(summaryLine({ total: 0, added: 0, modified: 0, deleted: 0, renamed: 0, other: 0 })).toBe(
      "no changes",
    );
    expect(summaryLine({ total: 1, added: 1, modified: 0, deleted: 0, renamed: 0, other: 0 })).toBe(
      "1 file · +1",
    );
    expect(summaryLine({ total: 4, added: 1, modified: 2, deleted: 1, renamed: 0, other: 0 })).toBe(
      "4 files · +1 ~2 -1",
    );
  });

  it("includes renamed (») and other (?) tallies in the summary line", () => {
    expect(summaryLine({ total: 3, added: 0, modified: 0, deleted: 0, renamed: 2, other: 1 })).toBe(
      "3 files · »2 ?1",
    );
  });

  it("omits the detail suffix when a non-empty diff has no categorised counts", () => {
    // Defensive: total > 0 with every bucket at 0 yields just the file count.
    expect(summaryLine({ total: 2, added: 0, modified: 0, deleted: 0, renamed: 0, other: 0 })).toBe(
      "2 files",
    );
  });
});

describe("change presentation helpers", () => {
  it("labels and badges each change kind", () => {
    expect(changeLabel("added")).toBe("added");
    expect(changeLabel("type-changed")).toBe("type changed");
    expect(changeLabel("unknown")).toBe("changed");
    expect(changeBadge("added")).toBe("A");
    expect(changeBadge("modified")).toBe("M");
    expect(changeBadge("deleted")).toBe("D");
    expect(changeBadge("renamed")).toBe("R");
    expect(changeBadge("copied")).toBe("C");
    expect(changeBadge("type-changed")).toBe("T");
    expect(changeBadge("unknown")).toBe("?");
  });
});
