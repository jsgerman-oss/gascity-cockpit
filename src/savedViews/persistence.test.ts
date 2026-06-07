// Unit tests for saved-views persistence + defensive migration (cockpit-0vi
// acceptance: "views persist across reloads" / "tests for persistence").
import { describe, expect, it } from "vitest";
import {
  STATE_KEY,
  loadState,
  normalizeState,
  saveState,
  type SavedViewsStore,
} from "./persistence.ts";
import { createView, emptyState, setActiveView } from "./model.ts";
import { DEFAULT_VIEW_ID, builtinViews } from "./defaults.ts";
import { PANE_IDS, SAVED_VIEWS_VERSION } from "./types.ts";

/** A fake `globalState` Memento over a Map. */
function fakeStore(initial?: unknown): SavedViewsStore & { raw(): unknown } {
  const map = new Map<string, unknown>();
  if (initial !== undefined) map.set(STATE_KEY, initial);
  return {
    get: (key) => map.get(key),
    update: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    raw: () => map.get(STATE_KEY),
  };
}

describe("normalizeState — seeding", () => {
  it("seeds defaults for non-object inputs", () => {
    for (const bad of [undefined, null, 42, "nope", true, []]) {
      const state = normalizeState(bad);
      expect(state.views.length).toBe(builtinViews().length);
      expect(state.activeId).toBe(DEFAULT_VIEW_ID);
      expect(state.version).toBe(SAVED_VIEWS_VERSION);
    }
  });

  it("seeds defaults when views is missing or all entries are junk", () => {
    expect(normalizeState({}).activeId).toBe(DEFAULT_VIEW_ID);
    expect(normalizeState({ views: [1, "x", null, {}, { id: "" }, { id: "a" }] }).views.map((v) => v.id)).toEqual(
      // only the {id:"a"} entry is missing a name → dropped → all junk → seeded
      builtinViews().map((v) => v.id),
    );
  });
});

describe("normalizeState — view coercion", () => {
  it("keeps valid views, drops invalid + duplicate ids", () => {
    const raw = {
      views: [
        { id: "keep", name: "Keep" },
        { id: "keep", name: "Dup" }, // duplicate id → dropped
        { id: "x", name: "  " }, // blank name → dropped
        { name: "no id" }, // missing id → dropped
        "garbage",
      ],
      activeId: "keep",
    };
    const state = normalizeState(raw);
    expect(state.views.map((v) => v.id)).toEqual(["keep"]);
    expect(state.activeId).toBe("keep");
  });

  it("nulls a dangling activeId without re-seeding when a view survives", () => {
    const state = normalizeState({ views: [{ id: "a", name: "A" }], activeId: "ghost" });
    expect(state.views.map((v) => v.id)).toEqual(["a"]);
    expect(state.activeId).toBeNull();
  });

  it("keeps a valid groupBy and the builtin flag, drops an invalid groupBy", () => {
    const state = normalizeState({
      views: [
        { id: "a", name: "A", groupBy: "rig", builtin: true },
        { id: "b", name: "B", groupBy: "nonsense" },
      ],
    });
    expect(state.views[0]).toMatchObject({ groupBy: "rig", builtin: true });
    expect(state.views[1].groupBy).toBeUndefined();
    expect(state.views[1].builtin).toBeUndefined();
  });

  it("coerces filter fields, dropping wrong types and non-finite priority", () => {
    const state = normalizeState({
      views: [
        {
          id: "a",
          name: "A",
          filters: {
            text: "  ", // blank → dropped
            status: ["ready", 7, "blocked"], // non-strings filtered out
            rig: "cockpit",
            assignee: "", // empty string is a valid "unassigned" filter
            type: 5, // wrong type → dropped
            priority: Number.POSITIVE_INFINITY, // non-finite → dropped
          },
        },
        { id: "b", name: "B", filters: { text: "hello", type: "feature", priority: 2 } },
      ],
    });
    expect(state.views[0].filters).toEqual({ status: ["ready", "blocked"], rig: "cockpit", assignee: "" });
    expect(state.views[1].filters).toEqual({ text: "hello", type: "feature", priority: 2 });
  });

  it("normalizes panes: drops unknown/dup ids, keeps visible:false, backfills missing panes", () => {
    const state = normalizeState({
      views: [
        {
          id: "a",
          name: "A",
          panes: [
            { id: "beads", visible: false },
            { id: "beads", visible: true }, // duplicate → dropped
            { id: "ghost", visible: true }, // unknown → dropped
            "junk",
          ],
        },
      ],
    });
    const panes = state.views[0].panes;
    expect(panes.map((p) => p.id).sort()).toEqual([...PANE_IDS].sort());
    expect(panes.find((p) => p.id === "beads")?.visible).toBe(false);
    // every backfilled pane is visible
    expect(panes.filter((p) => p.id !== "beads").every((p) => p.visible)).toBe(true);
  });
});

describe("loadState / saveState", () => {
  it("loads + normalizes from the store", () => {
    const store = fakeStore({ views: [{ id: "a", name: "A" }], activeId: "a" });
    expect(loadState(store).views.map((v) => v.id)).toEqual(["a"]);
  });

  it("seeds defaults when the store is empty", () => {
    expect(loadState(fakeStore()).activeId).toBe(DEFAULT_VIEW_ID);
  });

  it("round-trips a state through save → load unchanged", async () => {
    const built = createView(emptyState(), {
      name: "Triage",
      groupBy: "rig",
      filters: { status: ["blocked"], priority: 1 },
    });
    const original = setActiveView(built.state, built.view.id);

    const store = fakeStore();
    await saveState(store, original);
    expect(store.raw()).toEqual(original); // persisted verbatim

    const reloaded = loadState(store);
    expect(reloaded).toEqual(original); // survives a reload intact
  });
});
