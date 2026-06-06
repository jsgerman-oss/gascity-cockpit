/**
 * Coverage suite for the beads feature (cockpit-g5l.2).
 *
 * The beads feature wires the beads explorer onto the host and reloads it on
 * *meaningful* connection transitions only — first connect, a supervisor restart,
 * or the API dropping out — keying off the previous state the host passes in. The
 * central test drives a full sweep of those transitions and asserts the tree
 * refreshes exactly when the feature's guard says it should, covering every
 * branch of the listener. The rest invoke the explorer commands the feature
 * contributes.
 */
import { describe, expect, it } from "vitest";
import beadsFeature from "./beads.feature.ts";
import { makeRecord } from "../beads/fixtures.ts";
import type { BeadLeaf } from "../beads/index.ts";
import { createTestbed } from "../test/fake-host.ts";
import type { TreeDataProviderLike } from "../test/fake-vscode.ts";

/** Subscribe to a tree provider's change event and count how often it fires. */
function countTreeChanges(provider: TreeDataProviderLike): () => number {
  let fired = 0;
  provider.onDidChangeTreeData?.(() => {
    fired += 1;
  });
  return () => fired;
}

function beadNode(beadId = "cockpit-1", city = "alpha"): BeadLeaf {
  return {
    kind: "bead",
    id: `bead:${city}:${beadId}`,
    city,
    beadId,
    record: makeRecord({ id: beadId }, null, city),
    displayStatus: "open",
  };
}

describe("beads feature", () => {
  it("registers the beads tree view and its explorer commands", () => {
    const tb = createTestbed();
    tb.activate(beadsFeature);

    expect(tb.getView("gascityCockpit.beads")).toBeDefined();
    for (const id of [
      "gascityCockpit.beads.refresh",
      "gascityCockpit.beads.setGroupBy",
      "gascityCockpit.beads.toggleClosed",
      "gascityCockpit.beads.toggleOperational",
      "gascityCockpit.beads.filter",
      "gascityCockpit.beads.clearFilters",
      "gascityCockpit.beads.openDetail",
      "gascityCockpit.beads.showGraph",
      "gascityCockpit.beads.copyId",
    ]) {
      expect(tb.hasCommand(id), `command ${id} should be registered`).toBe(true);
    }
  });

  it("reloads the tree only on meaningful connection transitions", async () => {
    const tb = createTestbed();
    tb.activate(beadsFeature);
    const provider = tb.getTreeProvider("gascityCockpit.beads")!;
    const changes = countTreeChanges(provider);

    // Helper: fire a transition, let any async reload settle, return the delta.
    const step = async (fire: () => void): Promise<number> => {
      const before = changes();
      fire();
      await tb.flush();
      return changes() - before;
    };

    // connecting (prev null): not connected/dropped/restarted → no reload.
    expect(await step(() => tb.emitStatus("connecting"))).toBe(0);
    // first connect (prev connecting): connected → reload.
    expect(await step(() => tb.emitStatus("connected"))).toBeGreaterThan(0);
    // still connected (prev connected): routine poll → no reload.
    expect(await step(() => tb.emitStatus("connected"))).toBe(0);
    // API drops out (prev connected): dropped → reload.
    expect(await step(() => tb.emitStatus("unavailable"))).toBeGreaterThan(0);
    // still unavailable (prev unavailable): no fresh drop → no reload.
    expect(await step(() => tb.emitStatus("unavailable"))).toBe(0);
    // supervisor restart while neither connecting nor dropping: restarted → reload.
    expect(await step(() => tb.emitStatus("degraded", { restarted: true }))).toBeGreaterThan(0);
  });

  it("toggleClosed flips the filter and notifies", async () => {
    const tb = createTestbed();
    tb.activate(beadsFeature);

    await tb.invokeCommand("gascityCockpit.beads.toggleClosed");
    expect(tb.infoMessages().map((m) => m.message)).toContain("Closed beads shown.");
  });

  it("toggleOperational flips the wisp filter and notifies", async () => {
    const tb = createTestbed();
    tb.activate(beadsFeature);

    // Operational wisps are hidden by default, so the first toggle reveals them.
    await tb.invokeCommand("gascityCockpit.beads.toggleOperational");
    expect(tb.infoMessages().map((m) => m.message)).toContain("Operational wisps shown.");
  });

  it("copyId copies a bead id from a node and notifies", async () => {
    const tb = createTestbed();
    tb.activate(beadsFeature);

    await tb.invokeCommand("gascityCockpit.beads.copyId", beadNode("cockpit-42"));

    expect(tb.state.clipboard.text).toBe("cockpit-42");
    expect(tb.infoMessages().map((m) => m.message)).toContain("Copied cockpit-42");
  });

  it("node commands are no-ops (not throws) when invoked without a bead", async () => {
    const tb = createTestbed();
    tb.activate(beadsFeature);

    await expect(tb.invokeCommand("gascityCockpit.beads.openDetail")).resolves.not.toThrow();
    await expect(tb.invokeCommand("gascityCockpit.beads.showGraph")).resolves.not.toThrow();
    await expect(tb.invokeCommand("gascityCockpit.beads.copyId")).resolves.not.toThrow();
    expect(tb.state.clipboard.text).toBe("");
  });

  it("refresh, clearFilters, setGroupBy and filter run without a connection", async () => {
    const tb = createTestbed();
    tb.activate(beadsFeature);

    // refresh kicks a load (which fails fast with no client) but never throws.
    await expect(tb.invokeCommand("gascityCockpit.beads.refresh")).resolves.not.toThrow();
    await expect(tb.invokeCommand("gascityCockpit.beads.clearFilters")).resolves.not.toThrow();
    // setGroupBy / filter open a QuickPick; with nothing queued the user "cancels".
    await expect(tb.invokeCommand("gascityCockpit.beads.setGroupBy")).resolves.not.toThrow();
    await expect(tb.invokeCommand("gascityCockpit.beads.filter")).resolves.not.toThrow();
    expect(tb.state.quickPickCalls.length).toBeGreaterThan(0);
  });
});
