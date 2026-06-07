// Unit tests for the shipped default views + seeding (cockpit-0vi acceptance:
// "at least one default view shipped").
import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW_ID, builtinViews, seedDefaults } from "./defaults.ts";
import { createView, defaultPanes, emptyState } from "./model.ts";
import { GROUP_KEYS } from "../beads/index.ts";
import { PANE_IDS } from "./types.ts";

describe("builtinViews", () => {
  it("ships at least one default, all flagged builtin with unique ids", () => {
    const views = builtinViews();
    expect(views.length).toBeGreaterThanOrEqual(1);
    expect(views.every((v) => v.builtin === true)).toBe(true);
    expect(new Set(views.map((v) => v.id)).size).toBe(views.length);
  });

  it("includes the default view id", () => {
    expect(builtinViews().some((v) => v.id === DEFAULT_VIEW_ID)).toBe(true);
  });

  it("every builtin is structurally valid (groupBy, panes, statuses)", () => {
    for (const view of builtinViews()) {
      if (view.groupBy) expect(GROUP_KEYS).toContain(view.groupBy);
      expect(view.panes.map((p) => p.id).sort()).toEqual([...PANE_IDS].sort());
    }
  });

  it("returns fresh copies each call (no shared pane arrays)", () => {
    const a = builtinViews();
    const b = builtinViews();
    expect(a[0].panes).not.toBe(b[0].panes);
    a[0].panes[0].visible = false;
    expect(b[0].panes[0].visible).toBe(true);
  });
});

describe("seedDefaults", () => {
  it("seeds builtins and activates the default when the store is empty", () => {
    const seeded = seedDefaults(emptyState());
    expect(seeded.views.length).toBe(builtinViews().length);
    expect(seeded.activeId).toBe(DEFAULT_VIEW_ID);
  });

  it("is a no-op when any view already exists", () => {
    const { state } = createView(emptyState(), { name: "Mine" });
    const seeded = seedDefaults(state);
    expect(seeded).toBe(state);
    expect(seeded.views.map((v) => v.id)).toEqual(["mine"]);
  });

  it("the seeded default applies no filters (shows all work)", () => {
    const seeded = seedDefaults(emptyState());
    const dflt = seeded.views.find((v) => v.id === DEFAULT_VIEW_ID)!;
    expect(dflt.filters).toEqual({});
    expect(dflt.panes).toEqual(defaultPanes());
  });
});
