/**
 * Coverage for the "new bead from selection" feature (cockpit-g5l.3, batch B).
 *
 * The feature itself is a one-liner — it registers the editor command and wires
 * `getClient`/`log` from the host. We drive that command end-to-end against the
 * fake host: the empty path (no editor), the error path (no client), and a full
 * happy path that files a bead through a fake supervisor client and copies its
 * id. The bead-shaping core (`buildBeadInput`, `suggestTitle`) and the editor
 * glue live elsewhere; here we only assert the feature's seam — that the command
 * exists and reaches the client the host hands it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import beadFromSelectionFeature from "./beadFromSelection.feature.ts";
import type { CockpitClient } from "../api/index.ts";
import { createTestbed } from "../test/fake-host.ts";
import { Uri } from "../test/fake-vscode.ts";

const NEW_FROM_SELECTION = "gascityCockpit.beads.newFromSelection";

/** A fake editor with a non-empty multi-line selection over a real-ish document. */
function fakeEditor(text = "const answer = 42;"): unknown {
  return {
    document: {
      uri: Uri.file("/ws/src/answer.ts"),
      languageId: "typescript",
      getText: () => text,
    },
    selection: {
      start: { line: 9, character: 2 },
      end: { line: 11, character: 5 },
      isEmpty: false,
    },
    selections: [],
  };
}

afterEach(() => vi.restoreAllMocks());

describe("beadFromSelection feature", () => {
  it("registers the new-bead editor command", () => {
    const tb = createTestbed();
    tb.activate(beadFromSelectionFeature);

    expect(tb.hasCommand(NEW_FROM_SELECTION)).toBe(true);
    expect(tb.subscriptions()).toHaveLength(1);

    tb.disposeAll();
    expect(tb.hasCommand(NEW_FROM_SELECTION)).toBe(false);
  });

  it("nudges the user when there is no active editor", async () => {
    const tb = createTestbed();
    tb.activate(beadFromSelectionFeature);

    await tb.invokeCommand(NEW_FROM_SELECTION);

    expect(tb.infoMessages().map((m) => m.message)).toContain(
      "Open a file and put the cursor in (or select) the code to file a bead from it.",
    );
    tb.disposeAll();
  });

  it("warns when an editor is open but no supervisor is connected", async () => {
    // client stays null (default) — the host's getClient() arrow is exercised.
    const tb = createTestbed();
    tb.state.activeTextEditor = fakeEditor() as never;
    tb.activate(beadFromSelectionFeature);

    await tb.invokeCommand(NEW_FROM_SELECTION);

    expect(tb.warnMessages().map((m) => m.message)).toContain(
      "Not connected to a supervisor API — can't create a bead.",
    );
    tb.disposeAll();
  });

  it("files a bead through the connected client and copies its id", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = {
      GET: async (path: string) =>
        path === "/v0/cities"
          ? { data: { items: [{ name: "alpha", running: true }] } }
          : { data: undefined, error: { title: "unexpected" } },
      POST: async (path: string, init: { body: unknown }) => {
        posts.push({ path, body: init.body });
        return { data: { id: "alpha-7" } };
      },
    } as unknown as CockpitClient;

    const tb = createTestbed({ client });
    tb.state.activeTextEditor = fakeEditor() as never;
    tb.activate(beadFromSelectionFeature);

    tb.queueInput("Investigate the answer"); // the title prompt
    tb.queueQuickPick({ name: "alpha" }); // the city picker
    tb.queueMessage("Copy ID"); // the post-file toast action

    await tb.invokeCommand(NEW_FROM_SELECTION);
    await tb.flush();

    // A create POST went to the picked city, carrying the typed title.
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ title: "Investigate the answer" });
    // The success toast names the new bead, and "Copy ID" wrote it to the clipboard.
    expect(tb.infoMessages().map((m) => m.message)).toContain("Filed alpha-7 in alpha.");
    expect(tb.state.clipboard.text).toBe("alpha-7");
    // The explorer was asked to refresh so the new bead shows up.
    expect(tb.state.executedCommands.map((c) => c.command)).toContain(
      "gascityCockpit.beads.refresh",
    );
    tb.disposeAll();
  });
});
