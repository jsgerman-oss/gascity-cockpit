// Unit tests for the saved-views CRUD + selection model (cockpit-0vi).
import { describe, expect, it } from "vitest";
import {
  createView,
  defaultPanes,
  deleteView,
  emptyState,
  getActiveView,
  getView,
  normalizeName,
  renameView,
  setActiveView,
  slugify,
  uniqueId,
  updateViewContent,
} from "./model.ts";
import { PANE_IDS, SAVED_VIEWS_VERSION, type SavedViewsState } from "./types.ts";

describe("emptyState / defaultPanes", () => {
  it("emptyState is a versioned, empty store", () => {
    expect(emptyState()).toEqual({ version: SAVED_VIEWS_VERSION, views: [], activeId: null });
  });

  it("defaultPanes lists every pane, visible, in canonical order", () => {
    const panes = defaultPanes();
    expect(panes.map((p) => p.id)).toEqual([...PANE_IDS]);
    expect(panes.every((p) => p.visible)).toBe(true);
  });
});

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("All Work")).toBe("all-work");
    expect(slugify("  Needs   Attention!! ")).toBe("needs-attention");
    expect(slugify("P0 / blocked")).toBe("p0-blocked");
  });

  it("falls back to 'view' when nothing survives", () => {
    expect(slugify("!!!")).toBe("view");
    expect(slugify("")).toBe("view");
  });
});

describe("uniqueId", () => {
  it("returns the base when free", () => {
    expect(uniqueId("all-work", [])).toBe("all-work");
    expect(uniqueId("all-work", ["other"])).toBe("all-work");
  });

  it("suffixes -2, -3, … past collisions", () => {
    expect(uniqueId("view", ["view"])).toBe("view-2");
    expect(uniqueId("view", ["view", "view-2"])).toBe("view-3");
    expect(uniqueId("view", ["view", "view-2", "view-3"])).toBe("view-4");
  });
});

describe("normalizeName", () => {
  it("trims a valid name", () => {
    expect(normalizeName("  Triage  ")).toBe("Triage");
  });

  it("throws on an empty/whitespace name", () => {
    expect(() => normalizeName("   ")).toThrow(/empty/);
    expect(() => normalizeName("")).toThrow(/empty/);
  });
});

describe("createView", () => {
  it("appends a view with an id derived from the name and default panes", () => {
    const { state, view } = createView(emptyState(), { name: "All Work" });
    expect(view.id).toBe("all-work");
    expect(view.name).toBe("All Work");
    expect(view.filters).toEqual({});
    expect(view.panes).toEqual(defaultPanes());
    expect(view.groupBy).toBeUndefined();
    expect(state.views).toHaveLength(1);
  });

  it("captures groupBy, filters, and an explicit pane layout", () => {
    const panes = [{ id: "beads" as const, visible: true }, { id: "fleet" as const, visible: false }];
    const { view } = createView(emptyState(), {
      name: "Triage",
      groupBy: "rig",
      filters: { status: ["blocked"], priority: 0 },
      panes,
    });
    expect(view.groupBy).toBe("rig");
    expect(view.filters).toEqual({ status: ["blocked"], priority: 0 });
    expect(view.panes).toEqual(panes);
    // panes are cloned, not shared by reference
    expect(view.panes).not.toBe(panes);
  });

  it("disambiguates ids when two views share a name", () => {
    const first = createView(emptyState(), { name: "Work" });
    const second = createView(first.state, { name: "Work" });
    expect(second.view.id).toBe("work-2");
    expect(second.state.views.map((v) => v.id)).toEqual(["work", "work-2"]);
  });

  it("does not mutate the input state", () => {
    const start = emptyState();
    createView(start, { name: "Work" });
    expect(start.views).toHaveLength(0);
  });

  it("rejects an empty name", () => {
    expect(() => createView(emptyState(), { name: "  " })).toThrow(/empty/);
  });
});

describe("renameView", () => {
  it("renames an existing view, keeping its id", () => {
    const { state } = createView(emptyState(), { name: "Work" });
    const next = renameView(state, "work", "Active Work");
    expect(next.views[0]).toMatchObject({ id: "work", name: "Active Work" });
  });

  it("throws for an unknown id and for an empty name", () => {
    const { state } = createView(emptyState(), { name: "Work" });
    expect(() => renameView(state, "nope", "X")).toThrow(/No saved view/);
    expect(() => renameView(state, "work", "  ")).toThrow(/empty/);
  });
});

describe("deleteView", () => {
  it("removes a view and clears activeId when the active view is deleted", () => {
    const { state, view } = createView(emptyState(), { name: "Work" });
    const active = setActiveView(state, view.id);
    const next = deleteView(active, view.id);
    expect(next.views).toHaveLength(0);
    expect(next.activeId).toBeNull();
  });

  it("keeps activeId when a different view is deleted", () => {
    const a = createView(emptyState(), { name: "A" });
    const b = createView(a.state, { name: "B" });
    const active = setActiveView(b.state, "a");
    const next = deleteView(active, "b");
    expect(next.activeId).toBe("a");
    expect(next.views.map((v) => v.id)).toEqual(["a"]);
  });

  it("is a no-op for an unknown id", () => {
    const { state } = createView(emptyState(), { name: "Work" });
    expect(deleteView(state, "nope").views).toHaveLength(1);
  });
});

describe("setActiveView", () => {
  it("sets a valid active id and clears with null", () => {
    const { state } = createView(emptyState(), { name: "Work" });
    expect(setActiveView(state, "work").activeId).toBe("work");
    expect(setActiveView(state, null).activeId).toBeNull();
  });

  it("throws for an unknown id", () => {
    expect(() => setActiveView(emptyState(), "ghost")).toThrow(/No saved view/);
  });
});

describe("updateViewContent", () => {
  it("overwrites only the fields present in the patch", () => {
    const { state } = createView(emptyState(), { name: "Work", groupBy: "status", filters: { rig: "a" } });
    const next = updateViewContent(state, "work", {
      filters: { status: ["ready"] },
      groupBy: "assignee",
      panes: [{ id: "beads", visible: true }],
    });
    expect(next.views[0].filters).toEqual({ status: ["ready"] });
    expect(next.views[0].groupBy).toBe("assignee");
    expect(next.views[0].panes).toEqual([{ id: "beads", visible: true }]);
  });

  it("leaves untouched fields when the patch omits them", () => {
    const { state } = createView(emptyState(), { name: "Work", groupBy: "status", filters: { rig: "a" } });
    const next = updateViewContent(state, "work", {});
    expect(next.views[0]).toMatchObject({ groupBy: "status", filters: { rig: "a" } });
  });

  it("updates only the targeted view, leaving siblings untouched", () => {
    const a = createView(emptyState(), { name: "A", filters: { rig: "x" } });
    const b = createView(a.state, { name: "B", filters: { rig: "y" } });
    const next = updateViewContent(b.state, "b", { filters: { rig: "z" } });
    expect(next.views.find((v) => v.id === "a")?.filters).toEqual({ rig: "x" });
    expect(next.views.find((v) => v.id === "b")?.filters).toEqual({ rig: "z" });
  });

  it("throws for an unknown id", () => {
    expect(() => updateViewContent(emptyState(), "nope", {})).toThrow(/No saved view/);
  });
});

describe("getView / getActiveView", () => {
  it("getView finds by id or returns undefined", () => {
    const { state } = createView(emptyState(), { name: "Work" });
    expect(getView(state, "work")?.name).toBe("Work");
    expect(getView(state, "nope")).toBeUndefined();
  });

  it("getActiveView resolves the active view, or null", () => {
    const { state, view } = createView(emptyState(), { name: "Work" });
    expect(getActiveView(state)).toBeNull(); // none active yet
    expect(getActiveView(setActiveView(state, view.id))?.id).toBe("work");
  });

  it("getActiveView returns null when activeId dangles", () => {
    const dangling: SavedViewsState = { version: SAVED_VIEWS_VERSION, views: [], activeId: "ghost" };
    expect(getActiveView(dangling)).toBeNull();
  });
});
