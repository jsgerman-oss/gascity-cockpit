import { describe, expect, it } from "vitest";
import {
  branchLine,
  buildQueueTree,
  entryTooltip,
  prRef,
  stateIcon,
  stateLabel,
} from "./format.ts";
import type { MergeEntryNode, MergeGroupNode, MergeMessageNode, MergeQueueEntry } from "./types.ts";

function entry(over: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    city: "alpha",
    beadId: "x.1",
    title: "Do a thing",
    assignee: "alpha/gastown.refinery",
    state: "awaiting",
    target: "main",
    ...over,
  };
}

describe("stateLabel / stateIcon", () => {
  it("labels each state", () => {
    expect(stateLabel("awaiting")).toBe("Awaiting merge");
    expect(stateLabel("rejected")).toBe("Needs rework");
    expect(stateLabel("merged")).toBe("Recently merged");
  });

  it("maps each state to a codicon id", () => {
    expect(stateIcon("awaiting")).toBe("git-pull-request");
    expect(stateIcon("rejected")).toBe("warning");
    expect(stateIcon("merged")).toBe("git-merge");
  });
});

describe("branchLine", () => {
  it("renders branch → target", () => {
    expect(branchLine(entry({ branch: "gc-cap-abc" }))).toBe("gc-cap-abc → main");
  });

  it("notes a missing branch", () => {
    expect(branchLine(entry({ branch: undefined, target: "develop" }))).toBe("(no branch) → develop");
  });
});

describe("prRef", () => {
  it("extracts host and number from a GitHub pull url", () => {
    expect(prRef("https://github.com/owner/repo/pull/123")).toBe("github.com #123");
  });

  it("extracts a GitLab merge-request number", () => {
    expect(prRef("https://gitlab.com/g/p/-/merge_requests/5")).toBe("gitlab.com #5");
  });

  it("falls back to the host when there is no number", () => {
    expect(prRef("https://example.com/some/where")).toBe("example.com");
  });

  it("returns PR for an unparseable url", () => {
    expect(prRef("not a url")).toBe("PR");
  });
});

describe("entryTooltip", () => {
  it("includes the rejection reason for rejected entries", () => {
    const md = entryTooltip(entry({ state: "rejected", branch: "b", rejectionReason: "rebase conflict" }));
    expect(md).toContain("State: Needs rework");
    expect(md).toContain("⚠ Rejected: rebase conflict");
  });

  it("notes when no worktree is recorded", () => {
    expect(entryTooltip(entry({ workDir: undefined }))).toContain("No worktree recorded");
  });

  it("shows a short merged sha", () => {
    expect(entryTooltip(entry({ state: "merged", mergedSha: "deadbeefcafe1234567" }))).toContain("`deadbeefcafe`");
  });
});

describe("buildQueueTree", () => {
  it("returns a single message node for an empty queue", () => {
    const tree = buildQueueTree([]);
    expect(tree).toHaveLength(1);
    expect((tree[0] as MergeMessageNode).kind).toBe("message");
    expect((tree[0] as MergeMessageNode).label).toBe("Merge queue is empty");
  });

  it("groups by state in display order with counts and entry-node ids", () => {
    const tree = buildQueueTree([
      entry({ beadId: "m", state: "merged" }),
      entry({ beadId: "a1", state: "awaiting" }),
      entry({ beadId: "a2", state: "awaiting" }),
    ]);
    expect(tree.map((n) => (n as MergeGroupNode).state)).toEqual(["awaiting", "merged"]);
    const awaiting = tree[0] as MergeGroupNode;
    expect(awaiting.count).toBe(2);
    expect(awaiting.label).toBe("Awaiting merge");
    expect((awaiting.children[0] as MergeEntryNode).id).toBe("alpha/a1");
  });
});
