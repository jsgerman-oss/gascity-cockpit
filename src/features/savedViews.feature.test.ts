// End-to-end tests for the Saved Views feature, driven through the fake-host
// testbed (cockpit-0vi). They activate the real feature glue + the Beads explorer
// together so the cross-feature IPC (apply a view → the beads filter changes) runs
// for real, and assert the two acceptance properties through the editor surface:
// persistence (globalState) and selection (switching applies a view's filter).
import { describe, expect, it } from "vitest";
import beadsFeature from "./beads.feature.ts";
import savedViewsFeature from "./savedViews.feature.ts";
import { STATE_KEY } from "../savedViews/index.ts";
import { createTestbed, type Testbed } from "../test/fake-host.ts";

const SWITCH = "gascityCockpit.savedViews.switch";
const SAVE = "gascityCockpit.savedViews.save";
const RENAME = "gascityCockpit.savedViews.rename";
const DELETE = "gascityCockpit.savedViews.delete";

/** The shape we read back out of the fake globalState. */
interface StoredView {
  id: string;
  name: string;
  groupBy?: string;
  filters: { status?: string[] };
  panes: Array<{ id: string; visible: boolean }>;
}
interface Stored {
  views: StoredView[];
  activeId: string | null;
}

/** The two getters we assert on the live beads provider. */
interface BeadsProbe {
  groupBy: string;
  filters: { status?: string[] };
}

function stored(tb: Testbed): Stored {
  return tb.context.globalState.get(STATE_KEY) as Stored;
}

function beadsProbe(tb: Testbed): BeadsProbe {
  return tb.getTreeProvider("gascityCockpit.beads") as unknown as BeadsProbe;
}

/** Activate beads first (so its IPC commands exist), then saved views. */
async function bootstrap(): Promise<Testbed> {
  const tb = createTestbed();
  tb.activate(beadsFeature);
  tb.activate(savedViewsFeature);
  await tb.flush(); // let the activate-time filter restore settle
  return tb;
}

describe("savedViews feature — registration & seeding", () => {
  it("registers its palette commands and a status-bar switcher", async () => {
    const tb = await bootstrap();
    for (const id of [SWITCH, SAVE, RENAME, DELETE, "gascityCockpit.savedViews.update"]) {
      expect(tb.hasCommand(id), `command ${id} should be registered`).toBe(true);
    }
    const bar = tb.statusBarItems();
    expect(bar).toHaveLength(1);
    expect(bar[0].command).toBe(SWITCH);
    expect(bar[0].text).toContain("All Work"); // seeded default is active
    expect(bar[0].shown).toBe(true);
  });

  it("seeds the default views into globalState on first run", async () => {
    const tb = await bootstrap();
    const state = stored(tb);
    expect(state.activeId).toBe("all-work");
    expect(state.views.map((v) => v.id)).toContain("needs-attention");
  });
});

describe("savedViews feature — switching applies the selection (acceptance: selection)", () => {
  it("switching to a view applies its groupBy + filter to the Beads explorer", async () => {
    const tb = await bootstrap();
    // The user picks "Needs Attention" from the quick-pick.
    tb.queueQuickPick({ id: "needs-attention" });
    await tb.invokeCommand(SWITCH);
    await tb.flush();

    const beads = beadsProbe(tb);
    expect(beads.groupBy).toBe("rig");
    expect(beads.filters.status).toEqual(["blocked", "escalated"]);

    // The status bar reflects the now-active view, persisted to globalState.
    expect(tb.statusBarItems()[0].text).toContain("Needs Attention");
    expect(stored(tb).activeId).toBe("needs-attention");
  });

  it("a cancelled switch leaves the active view unchanged", async () => {
    const tb = await bootstrap();
    tb.queueQuickPick(undefined); // user dismissed the picker
    await tb.invokeCommand(SWITCH);
    expect(stored(tb).activeId).toBe("all-work");
  });
});

describe("savedViews feature — save / rename / delete (acceptance: CRUD + persistence)", () => {
  it("saves the current filter + chosen panes as a new active view", async () => {
    const tb = await bootstrap();
    tb.queueInput("My Triage"); // the name prompt
    tb.queueQuickPick([{ id: "beads" }, { id: "fleet" }]); // the pane multi-select
    await tb.invokeCommand(SAVE);
    await tb.flush();

    const state = stored(tb);
    const saved = state.views.find((v) => v.id === "my-triage");
    expect(saved, "the new view persisted to globalState").toBeTruthy();
    expect(state.activeId).toBe("my-triage");
    // Only the chosen panes are visible.
    const visible = saved!.panes.filter((p) => p.visible).map((p) => p.id).sort();
    expect(visible).toEqual(["beads", "fleet"]);
    expect(tb.statusBarItems()[0].text).toContain("My Triage");
  });

  it("an empty name aborts the save", async () => {
    const tb = await bootstrap();
    const before = stored(tb).views.length;
    tb.queueInput("   ");
    await tb.invokeCommand(SAVE);
    expect(stored(tb).views.length).toBe(before);
  });

  it("renames an existing view", async () => {
    const tb = await bootstrap();
    tb.queueQuickPick({ id: "all-work" });
    tb.queueInput("Everything");
    await tb.invokeCommand(RENAME);

    const renamed = stored(tb).views.find((v) => v.id === "all-work");
    expect(renamed?.name).toBe("Everything");
  });

  it("deletes a view after confirmation", async () => {
    const tb = await bootstrap();
    tb.queueQuickPick({ id: "active-work" });
    tb.queueMessage("Delete"); // the modal confirm
    await tb.invokeCommand(DELETE);

    expect(stored(tb).views.find((v) => v.id === "active-work")).toBeUndefined();
  });

  it("a declined delete confirmation keeps the view", async () => {
    const tb = await bootstrap();
    tb.queueQuickPick({ id: "active-work" });
    tb.queueMessage(undefined); // user dismissed the confirm
    await tb.invokeCommand(DELETE);

    expect(stored(tb).views.find((v) => v.id === "active-work")).toBeTruthy();
  });
});

describe("savedViews feature — persistence across reload (acceptance: persistence)", () => {
  it("a saved view written by one session is restored by the next", async () => {
    const tb = await bootstrap();
    tb.queueInput("Persisted");
    tb.queueQuickPick([{ id: "beads" }]);
    await tb.invokeCommand(SAVE);
    await tb.flush();

    // Simulate a reload: re-activate the feature against the SAME host/globalState.
    savedViewsFeature.activate(tb.host);
    await tb.flush();

    // The most recent status-bar item (the reloaded session's) shows the view.
    const bars = tb.statusBarItems();
    expect(bars[bars.length - 1].text).toContain("Persisted");
    expect(stored(tb).activeId).toBe("persisted");
  });
});
