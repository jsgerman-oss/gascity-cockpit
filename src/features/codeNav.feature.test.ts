/**
 * Coverage suite for the codeNav feature (cockpit-g5l.2).
 *
 * codeNav is stateless with respect to the connection: `activate()` just wires
 * the bead → worktree → diff commands and a read-only diff content provider onto
 * the host. These tests drive `register()` through the fake host, invoke every
 * contributed command, and assert the no-bead / unresolvable-bead paths message
 * the user (rather than throw) — the behaviour the feature promises.
 */
import { describe, expect, it } from "vitest";
import codeNavFeature from "./codeNav.feature.ts";
import { makeRecord } from "../beads/fixtures.ts";
import type { BeadLeaf } from "../beads/index.ts";
import { createTestbed } from "../test/fake-host.ts";
import { Uri } from "../test/fake-vscode.ts";

const CMD = {
  openWorktree: "gascityCockpit.code.openWorktree",
  showDiff: "gascityCockpit.code.showDiff",
  browseFiles: "gascityCockpit.code.browseChangedFiles",
} as const;

/** A bead tree node, the only shape codeNav's commands navigate from. */
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

describe("codeNav feature", () => {
  it("registers the three nav commands and the read-only diff provider", () => {
    const tb = createTestbed();
    tb.activate(codeNavFeature);

    expect(tb.hasCommand(CMD.openWorktree)).toBe(true);
    expect(tb.hasCommand(CMD.showDiff)).toBe(true);
    expect(tb.hasCommand(CMD.browseFiles)).toBe(true);
    expect(tb.getContentProvider("gascity-worktree")).toBeDefined();
    // 3 commands + 1 content provider, nothing more.
    expect(tb.subscriptions().length).toBe(4);
  });

  it.each([CMD.openWorktree, CMD.showDiff, CMD.browseFiles])(
    "%s nudges the user when invoked without a bead",
    async (cmd) => {
      const tb = createTestbed();
      tb.activate(codeNavFeature);

      await tb.invokeCommand(cmd);

      expect(tb.infoMessages().map((m) => m.message)).toContain(
        "Open this from a bead in the Beads explorer.",
      );
    },
  );

  it("surfaces a load error when the bead cannot be fetched (no client)", async () => {
    // No client wired → the shared repository's getBead throws "API unavailable".
    const tb = createTestbed();
    tb.activate(codeNavFeature);

    await tb.invokeCommand(CMD.showDiff, beadNode("cockpit-7"));

    const errs = tb.errorMessages().map((m) => String(m.message));
    expect(errs.some((m) => m.includes("Could not load cockpit-7"))).toBe(true);
  });

  it("its diff content provider returns a notice when no worktree is in the URI", async () => {
    const tb = createTestbed();
    tb.activate(codeNavFeature);

    const provider = tb.getContentProvider("gascity-worktree")!;
    const uri = Uri.from({ scheme: "gascity-worktree", path: "/b.diff", query: "" });
    const body = await provider.provideTextDocumentContent(uri);

    expect(body).toBe("# No worktree path recorded for this bead.\n");
  });

  it("disposeAll tears the feature down", () => {
    const tb = createTestbed();
    tb.activate(codeNavFeature);
    expect(tb.hasCommand(CMD.openWorktree)).toBe(true);

    tb.disposeAll();
    expect(tb.hasCommand(CMD.openWorktree)).toBe(false);
    expect(tb.getContentProvider("gascity-worktree")).toBeUndefined();
  });
});
