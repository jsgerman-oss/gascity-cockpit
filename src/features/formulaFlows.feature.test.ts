/**
 * Coverage suite for the formulaFlows feature (cockpit-g5l.2).
 *
 * formulaFlows talks to the currently-connected supervisor through the host's
 * live client: `activate()` hands `registerFormulaFlows` a `() => host.getClient()`
 * accessor plus the shared repository and logger. These tests drive `register()`
 * through the fake host and invoke every contributed command on the
 * not-connected path — which is exactly what exercises the host-client accessor
 * the feature contributes.
 */
import { describe, expect, it } from "vitest";
import formulaFlowsFeature from "./formulaFlows.feature.ts";
import { makeRecord } from "../beads/fixtures.ts";
import type { BeadLeaf } from "../beads/index.ts";
import { createTestbed } from "../test/fake-host.ts";
import { Uri } from "../test/fake-vscode.ts";

const CMD = {
  preview: "gascityCockpit.formulas.preview",
  showRuns: "gascityCockpit.formulas.showRuns",
  runTdd: "gascityCockpit.beads.runTdd",
} as const;

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

describe("formulaFlows feature", () => {
  it("registers the three formula commands and the read-only doc provider", () => {
    const tb = createTestbed();
    tb.activate(formulaFlowsFeature);

    expect(tb.hasCommand(CMD.preview)).toBe(true);
    expect(tb.hasCommand(CMD.showRuns)).toBe(true);
    expect(tb.hasCommand(CMD.runTdd)).toBe(true);
    expect(tb.getContentProvider("gascity-formula")).toBeDefined();
    // provider + watcher-dispose + content-provider reg + doc-close listener + 3 commands.
    expect(tb.subscriptions().length).toBe(7);
  });

  it.each([CMD.preview, CMD.showRuns])(
    "%s warns when not connected (exercises the host-client accessor)",
    async (cmd) => {
      const tb = createTestbed(); // getClient() === null
      tb.activate(formulaFlowsFeature);

      await tb.invokeCommand(cmd);

      expect(tb.warnMessages().map((m) => m.message)).toContain(
        "Not connected to a supervisor API.",
      );
    },
  );

  it("runTdd nudges the user when invoked without a bead", async () => {
    const tb = createTestbed();
    tb.activate(formulaFlowsFeature);

    await tb.invokeCommand(CMD.runTdd);

    expect(tb.infoMessages().map((m) => m.message)).toContain(
      "Run this from a bead in the Beads explorer.",
    );
  });

  it("runTdd warns when a bead is given but no supervisor is connected", async () => {
    const tb = createTestbed();
    tb.activate(formulaFlowsFeature);

    await tb.invokeCommand(CMD.runTdd, beadNode("cockpit-9"));

    expect(tb.warnMessages().map((m) => m.message)).toContain(
      "Not connected to a supervisor API.",
    );
  });

  it("its content provider routes through the host client and reports disconnection", async () => {
    const tb = createTestbed();
    tb.activate(formulaFlowsFeature);

    const provider = tb.getContentProvider("gascity-formula")!;
    const uri = Uri.from({
      scheme: "gascity-formula",
      path: "/tdd.formula.md",
      query: "kind=detail&city=alpha&name=tdd&target=alpha/gastown.polecat",
    });
    const body = await provider.provideTextDocumentContent(uri);

    expect(body).toBe("# tdd\n\n> Not connected to a supervisor API.\n");
  });

  it("disposeAll tears the feature down", () => {
    const tb = createTestbed();
    tb.activate(formulaFlowsFeature);
    expect(tb.hasCommand(CMD.preview)).toBe(true);

    tb.disposeAll();
    expect(tb.hasCommand(CMD.preview)).toBe(false);
    expect(tb.getContentProvider("gascity-formula")).toBeUndefined();
  });
});
