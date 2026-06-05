import { describe, expect, it } from "vitest";
import { makeRecord } from "../beads/fixtures.ts";
import {
  deriveMergeQueue,
  isRefineryAssignee,
  mergeStateOf,
  summarize,
  toEntry,
} from "./derive.ts";
import type { Bead } from "./types.ts";

const REFINERY = "gascity-cockpit/gastown.refinery";

describe("isRefineryAssignee", () => {
  it("matches the rig-qualified refinery role", () => {
    expect(isRefineryAssignee(REFINERY)).toBe(true);
  });

  it("matches the bare role and other *.refinery agents", () => {
    expect(isRefineryAssignee("gastown.refinery")).toBe(true);
    expect(isRefineryAssignee("myrig/custom.refinery")).toBe(true);
    expect(isRefineryAssignee("refinery")).toBe(true);
  });

  it("rejects polecats, blanks, and nullish input", () => {
    expect(isRefineryAssignee("gascity-cockpit/gastown.polecat")).toBe(false);
    expect(isRefineryAssignee("   ")).toBe(false);
    expect(isRefineryAssignee(undefined)).toBe(false);
    expect(isRefineryAssignee(null)).toBe(false);
  });
});

describe("mergeStateOf", () => {
  const bead = (over: Partial<Bead>): Bead => makeRecord(over).bead;

  it("is awaiting when held by the refinery", () => {
    expect(mergeStateOf(bead({ assignee: REFINERY, metadata: { branch: "b" } }))).toBe("awaiting");
  });

  it("is rejected when kicked back to a polecat with a reason", () => {
    expect(
      mergeStateOf(bead({ assignee: "gascity-cockpit/gastown.polecat", metadata: { rejection_reason: "rebase" } })),
    ).toBe("rejected");
  });

  it("is merged when merge_result says so, even if still assigned to the refinery", () => {
    expect(mergeStateOf(bead({ assignee: REFINERY, metadata: { merge_result: "merged" } }))).toBe("merged");
  });

  it("prefers awaiting over a stale rejection once re-submitted to the refinery", () => {
    expect(
      mergeStateOf(bead({ assignee: REFINERY, metadata: { rejection_reason: "old", branch: "b" } })),
    ).toBe("awaiting");
  });

  it("is null for ordinary in-flight polecat work", () => {
    expect(
      mergeStateOf(bead({ assignee: "gascity-cockpit/gastown.polecat", metadata: { branch: "b", work_dir: "/w" } })),
    ).toBeNull();
  });
});

describe("toEntry", () => {
  it("flattens an awaiting bead, defaulting target to main and reading pr_url", () => {
    const entry = toEntry(
      makeRecord(
        {
          id: "x.1",
          title: "Wire it up",
          assignee: REFINERY,
          priority: 2,
          metadata: { branch: "gc-cap-abc", work_dir: "/w/cap", pr_url: "https://github.com/o/r/pull/7" },
        },
        null,
        "blackrim-hq",
      ),
    );
    expect(entry).toEqual({
      city: "blackrim-hq",
      beadId: "x.1",
      title: "Wire it up",
      assignee: REFINERY,
      state: "awaiting",
      target: "main",
      branch: "gc-cap-abc",
      workDir: "/w/cap",
      prUrl: "https://github.com/o/r/pull/7",
      priority: 2,
    });
  });

  it("falls back to existing_pr and honours an explicit target", () => {
    const entry = toEntry(
      makeRecord({ assignee: REFINERY, metadata: { existing_pr: "https://example/pr/1", target: "develop" } }),
    );
    expect(entry?.prUrl).toBe("https://example/pr/1");
    expect(entry?.target).toBe("develop");
  });

  it("carries the rejection reason only for rejected entries", () => {
    const rejected = toEntry(
      makeRecord({ assignee: "x/gastown.polecat", metadata: { rejection_reason: "conflict", branch: "b" } }),
    );
    expect(rejected?.state).toBe("rejected");
    expect(rejected?.rejectionReason).toBe("conflict");

    // Re-submitted to the refinery with the reason still lingering → not shown.
    const resubmitted = toEntry(makeRecord({ assignee: REFINERY, metadata: { rejection_reason: "conflict" } }));
    expect(resubmitted?.state).toBe("awaiting");
    expect(resubmitted?.rejectionReason).toBeUndefined();
  });

  it("carries the merged sha only for merged entries", () => {
    const entry = toEntry(makeRecord({ metadata: { merge_result: "merged", merged_sha: "deadbeefcafe1234" } }));
    expect(entry?.state).toBe("merged");
    expect(entry?.mergedSha).toBe("deadbeefcafe1234");
  });

  it("returns null for out-of-queue beads", () => {
    expect(toEntry(makeRecord({ assignee: "x/gastown.polecat", metadata: { branch: "b" } }))).toBeNull();
  });
});

describe("deriveMergeQueue", () => {
  it("keeps only queue beads and orders awaiting → rejected → merged, then by priority", () => {
    const records = [
      makeRecord({ id: "merged-1", metadata: { merge_result: "merged" } }),
      makeRecord({ id: "await-lo", assignee: REFINERY, priority: 5, metadata: { branch: "b" } }),
      makeRecord({ id: "ignore", assignee: "x/gastown.polecat", metadata: { branch: "b" } }),
      makeRecord({ id: "reject-1", assignee: "x/gastown.polecat", metadata: { rejection_reason: "r", branch: "b" } }),
      makeRecord({ id: "await-hi", assignee: REFINERY, priority: 1, metadata: { branch: "b" } }),
    ];
    const ids = deriveMergeQueue(records).map((e) => e.beadId);
    expect(ids).toEqual(["await-hi", "await-lo", "reject-1", "merged-1"]);
  });

  it("breaks ties by bead id", () => {
    const records = [
      makeRecord({ id: "b", assignee: REFINERY, metadata: { branch: "x" } }),
      makeRecord({ id: "a", assignee: REFINERY, metadata: { branch: "x" } }),
    ];
    expect(deriveMergeQueue(records).map((e) => e.beadId)).toEqual(["a", "b"]);
  });
});

describe("summarize", () => {
  it("tallies entries by state", () => {
    const records = [
      makeRecord({ id: "a", assignee: REFINERY, metadata: { branch: "b" } }),
      makeRecord({ id: "b", assignee: REFINERY, metadata: { branch: "b" } }),
      makeRecord({ id: "c", assignee: "x/gastown.polecat", metadata: { rejection_reason: "r" } }),
      makeRecord({ id: "d", metadata: { merge_result: "merged" } }),
    ];
    expect(summarize(deriveMergeQueue(records))).toEqual({ total: 4, awaiting: 2, rejected: 1, merged: 1 });
  });
});
