/**
 * Smoke tests for the fake-host harness (scaffold for cockpit-g5l).
 *
 * These prove the harness end-to-end: that a *real* host-abstracted feature can
 * be activated against the in-memory host + fake `vscode`, and that its commands,
 * views, and connection-status reactions are observable and drivable from a plain
 * Node test. They deliberately drive whole features (not the harness in
 * isolation) — that is the property the 11 feature-coverage beads depend on.
 *
 * They are not coverage tests for the features themselves; each feature gets its
 * own focused suite. Here we only assert the seams the harness exposes.
 */
import { describe, expect, it } from "vitest";
import beadsFeature from "../features/beads.feature.ts";
import codeNavFeature from "../features/codeNav.feature.ts";
import mergeQueueFeature from "../features/mergeQueue.feature.ts";
import type { ConnectionState } from "../discovery/index.ts";
import { createTestbed, makeStatus } from "./fake-host.ts";
import type { TreeDataProviderLike } from "./fake-vscode.ts";

/** Subscribe to a tree provider's change event and count how often it fires. */
function countTreeChanges(provider: TreeDataProviderLike): () => number {
  let fired = 0;
  provider.onDidChangeTreeData?.(() => {
    fired += 1;
  });
  return () => fired;
}

describe("fake-host harness", () => {
  it("starts with a clean recorder and an idle host", () => {
    const tb = createTestbed();
    expect(tb.commandIds()).toEqual([]);
    expect(tb.state.treeViews.size).toBe(0);
    expect(tb.host.getStatus().state).toBe("idle");
    expect(tb.host.getClient()).toBeNull();
  });

  it("fans out status changes with the previous state, mirroring the real host", () => {
    const tb = createTestbed();
    const seen: Array<{ state: ConnectionState; prev: ConnectionState | null }> = [];
    const sub = tb.host.onStatusChange((status, prev) => seen.push({ state: status.state, prev }));

    tb.emitStatus("connecting");
    tb.emitStatus("connected");
    tb.emitStatus("connected");
    tb.emitStatus("unavailable");

    expect(seen).toEqual([
      { state: "connecting", prev: null },
      { state: "connected", prev: "connecting" },
      { state: "connected", prev: "connected" },
      { state: "unavailable", prev: "connected" },
    ]);

    // The returned disposable detaches the listener.
    sub.dispose();
    tb.emitStatus("idle");
    expect(seen).toHaveLength(4);
  });

  it("makeStatus gives connected states an endpoint and others none", () => {
    expect(makeStatus("connected").endpoint).not.toBeNull();
    expect(makeStatus("unavailable").endpoint).toBeNull();
    expect(makeStatus("connected", { endpoint: null }).endpoint).toBeNull();
    expect(makeStatus("degraded", { detail: "starting" }).detail).toBe("starting");
  });

  it("disposeAll runs every disposable a feature registered", () => {
    const tb = createTestbed();
    tb.activate(codeNavFeature);
    expect(tb.commandIds().length).toBeGreaterThan(0);

    tb.disposeAll();
    expect(tb.hasCommand("gascityCockpit.code.openWorktree")).toBe(false);
    expect(tb.getContentProvider("gascity-worktree")).toBeUndefined();
  });
});

describe("codeNav feature (end-to-end through the harness)", () => {
  it("registers its commands and the read-only diff content provider", () => {
    const tb = createTestbed();
    tb.activate(codeNavFeature);

    for (const id of [
      "gascityCockpit.code.openWorktree",
      "gascityCockpit.code.showDiff",
      "gascityCockpit.code.browseChangedFiles",
    ]) {
      expect(tb.hasCommand(id), `command ${id} should be registered`).toBe(true);
    }
    expect(tb.getContentProvider("gascity-worktree")).toBeDefined();
    // content provider + 3 commands.
    expect(tb.subscriptions().length).toBe(4);
  });

  it("drives a command handler: 'open worktree' with no bead nudges the user", async () => {
    const tb = createTestbed();
    tb.activate(codeNavFeature);

    await tb.invokeCommand("gascityCockpit.code.openWorktree");

    expect(tb.infoMessages().map((m) => m.message)).toContain(
      "Open this from a bead in the Beads explorer.",
    );
  });
});

describe("beads feature (end-to-end through the harness)", () => {
  it("registers the beads tree view and explorer commands", () => {
    const tb = createTestbed();
    tb.activate(beadsFeature);

    expect(tb.getView("gascityCockpit.beads")).toBeDefined();
    expect(tb.hasCommand("gascityCockpit.beads.refresh")).toBe(true);
    expect(tb.hasCommand("gascityCockpit.beads.toggleClosed")).toBe(true);

    // The provider is wired but lazy — it shows a placeholder until a refresh.
    const provider = tb.getTreeProvider("gascityCockpit.beads");
    const roots = provider?.getChildren() as Array<{ kind: string }>;
    expect(roots.length).toBeGreaterThan(0);
  });

  it("reacts to a supervisor connection: the tree refreshes", async () => {
    const tb = createTestbed();
    tb.activate(beadsFeature);

    const provider = tb.getTreeProvider("gascityCockpit.beads")!;
    const changes = countTreeChanges(provider);

    // First connect (prevState null → connected) triggers a reload. With no
    // client wired, the reload surfaces an error notice — but the point is the
    // feature reacted and the tree re-rendered.
    tb.emitStatus("connected");
    await tb.flush();

    expect(changes()).toBeGreaterThan(0);
    expect((provider.getChildren() as unknown[]).length).toBeGreaterThan(0);
  });

  it("drives a command handler: toggling closed beads writes state and notifies", async () => {
    const tb = createTestbed();
    tb.activate(beadsFeature);

    await tb.invokeCommand("gascityCockpit.beads.toggleClosed");

    expect(tb.infoMessages().map((m) => m.message)).toContain("Closed beads shown.");
  });
});

describe("mergeQueue feature (harness reuse across features)", () => {
  it("registers its view and commands and loads on activation", async () => {
    const tb = createTestbed();
    tb.activate(mergeQueueFeature);

    expect(tb.getView("gascityCockpit.mergeQueue")).toBeDefined();
    expect(tb.hasCommand("gascityCockpit.mergeQueue.refresh")).toBe(true);
    expect(tb.getContentProvider("gascity-merge-review")).toBeDefined();

    // registerMergeQueue kicks an initial refresh; it settles without throwing.
    await tb.flush();
    const provider = tb.getTreeProvider("gascityCockpit.mergeQueue");
    expect(provider).toBeDefined();
  });

  it("reacts to a supervisor connection by refreshing the queue", async () => {
    const tb = createTestbed();
    tb.activate(mergeQueueFeature);
    await tb.flush(); // let the activation refresh settle first

    const provider = tb.getTreeProvider("gascityCockpit.mergeQueue")!;
    const changes = countTreeChanges(provider);

    tb.emitStatus("connected");
    await tb.flush();

    expect(changes()).toBeGreaterThan(0);
  });
});
