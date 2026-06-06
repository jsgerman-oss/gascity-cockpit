/**
 * Coverage suite for the mergeQueue feature (cockpit-g5l.2).
 *
 * The merge-queue feature wires the review tree onto the host and, like the beads
 * explorer, reloads it only on meaningful connection transitions — first connect,
 * a supervisor restart, or the API dropping out. The central test sweeps those
 * transitions and asserts the queue reloads exactly when the guard says it
 * should, covering every branch of the listener. The rest invoke the queue's
 * contributed commands on their empty / no-PR / no-worktree paths.
 */
import { describe, expect, it } from "vitest";
import mergeQueueFeature from "./mergeQueue.feature.ts";
import type { MergeEntryNode, MergeQueueEntry } from "../mergeQueue/index.ts";
import { createTestbed } from "../test/fake-host.ts";
import type { TreeDataProviderLike } from "../test/fake-vscode.ts";

function countTreeChanges(provider: TreeDataProviderLike): () => number {
  let fired = 0;
  provider.onDidChangeTreeData?.(() => {
    fired += 1;
  });
  return () => fired;
}

/** Build a merge-queue entry node (the shape the queue's commands act on). */
function entryNode(over: Partial<MergeQueueEntry> = {}): MergeEntryNode {
  return {
    kind: "entry",
    id: `entry:${over.beadId ?? "cockpit-1"}`,
    entry: {
      city: "alpha",
      beadId: "cockpit-1",
      title: "Some work",
      assignee: "",
      state: "awaiting",
      target: "main",
      ...over,
    },
  };
}

describe("mergeQueue feature", () => {
  it("registers the queue view, its commands and the diff provider", () => {
    const tb = createTestbed();
    tb.activate(mergeQueueFeature);

    expect(tb.getView("gascityCockpit.mergeQueue")).toBeDefined();
    for (const id of [
      "gascityCockpit.mergeQueue.refresh",
      "gascityCockpit.mergeQueue.toggleMerged",
      "gascityCockpit.mergeQueue.reviewChanges",
      "gascityCockpit.mergeQueue.openPr",
      "gascityCockpit.mergeQueue.approveMerge",
      "gascityCockpit.mergeQueue.copyBranch",
    ]) {
      expect(tb.hasCommand(id), `command ${id} should be registered`).toBe(true);
    }
    expect(tb.getContentProvider("gascity-merge-review")).toBeDefined();
  });

  it("reloads the queue only on meaningful connection transitions", async () => {
    const tb = createTestbed();
    tb.activate(mergeQueueFeature);
    await tb.flush(); // let the activation refresh settle before counting.

    const provider = tb.getTreeProvider("gascityCockpit.mergeQueue")!;
    const changes = countTreeChanges(provider);

    const step = async (fire: () => void): Promise<number> => {
      const before = changes();
      fire();
      await tb.flush();
      return changes() - before;
    };

    expect(await step(() => tb.emitStatus("connecting"))).toBe(0);
    expect(await step(() => tb.emitStatus("connected"))).toBeGreaterThan(0);
    expect(await step(() => tb.emitStatus("connected"))).toBe(0);
    expect(await step(() => tb.emitStatus("unavailable"))).toBeGreaterThan(0);
    expect(await step(() => tb.emitStatus("unavailable"))).toBe(0);
    expect(await step(() => tb.emitStatus("degraded", { restarted: true }))).toBeGreaterThan(0);
  });

  it("toggleMerged flips the show-merged state and notifies", async () => {
    const tb = createTestbed();
    tb.activate(mergeQueueFeature);

    await tb.invokeCommand("gascityCockpit.mergeQueue.toggleMerged");
    expect(tb.infoMessages().map((m) => m.message)).toContain(
      "Merge queue: recently-merged shown.",
    );
  });

  it("reviewChanges nudges the user when nothing is selected", async () => {
    const tb = createTestbed();
    tb.activate(mergeQueueFeature);

    await tb.invokeCommand("gascityCockpit.mergeQueue.reviewChanges");
    expect(tb.infoMessages().map((m) => m.message)).toContain(
      "Pick a merge-queue entry to review.",
    );
  });

  it("reviewChanges reports a missing worktree for an entry with neither worktree nor PR", async () => {
    const tb = createTestbed();
    tb.activate(mergeQueueFeature);

    await tb.invokeCommand("gascityCockpit.mergeQueue.reviewChanges", entryNode({ beadId: "cockpit-3" }));
    const msgs = tb.infoMessages().map((m) => String(m.message));
    expect(msgs.some((m) => m.includes("cockpit-3") && m.includes("no worktree recorded"))).toBe(true);
  });

  it("openPr opens the recorded PR URL externally", async () => {
    const tb = createTestbed();
    tb.activate(mergeQueueFeature);

    await tb.invokeCommand(
      "gascityCockpit.mergeQueue.openPr",
      entryNode({ prUrl: "https://example.test/pr/1" }),
    );
    expect(tb.state.openedExternal).toContain("https://example.test/pr/1");
  });

  it("approveMerge says so when an entry is already merged", async () => {
    const tb = createTestbed();
    tb.activate(mergeQueueFeature);

    await tb.invokeCommand(
      "gascityCockpit.mergeQueue.approveMerge",
      entryNode({ beadId: "cockpit-5", state: "merged" }),
    );
    expect(tb.infoMessages().map((m) => String(m.message))).toContain("cockpit-5 is already merged.");
  });

  it("copyBranch copies a branch, or reports its absence", async () => {
    const tb = createTestbed();
    tb.activate(mergeQueueFeature);

    await tb.invokeCommand(
      "gascityCockpit.mergeQueue.copyBranch",
      entryNode({ branch: "polecat/cockpit-1" }),
    );
    expect(tb.state.clipboard.text).toBe("polecat/cockpit-1");
    expect(tb.infoMessages().map((m) => m.message)).toContain("Copied polecat/cockpit-1");

    await tb.invokeCommand("gascityCockpit.mergeQueue.copyBranch", entryNode({ branch: undefined }));
    expect(tb.infoMessages().map((m) => m.message)).toContain("No branch recorded for this entry.");
  });

  it("refresh runs without a connection and never throws", async () => {
    const tb = createTestbed();
    tb.activate(mergeQueueFeature);

    await expect(tb.invokeCommand("gascityCockpit.mergeQueue.refresh")).resolves.not.toThrow();
  });
});
