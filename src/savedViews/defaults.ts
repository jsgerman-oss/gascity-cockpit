// The saved views shipped out of the box (cockpit-0vi acceptance: "at least one
// default view shipped"). Seeded on first run and whenever the store would
// otherwise be empty, so the operator always has a starting point and the feature
// is discoverable without first having to build a view by hand.
import { defaultPanes } from "./model.ts";
import { SAVED_VIEWS_VERSION, type SavedView, type SavedViewsState } from "./types.ts";

/** The view made active on a fresh seed. */
export const DEFAULT_VIEW_ID = "all-work";

/**
 * Fresh copies of the built-in views. A factory (not a shared const) so each seed
 * gets its own pane-layout arrays — callers may edit a view in place without it
 * bleeding into the next seed.
 */
export function builtinViews(): SavedView[] {
  return [
    {
      id: DEFAULT_VIEW_ID,
      name: "All Work",
      builtin: true,
      groupBy: "status",
      filters: {},
      panes: defaultPanes(),
    },
    {
      id: "active-work",
      name: "Active Work",
      builtin: true,
      groupBy: "status",
      filters: { status: ["in_progress", "ready", "blocked"] },
      panes: defaultPanes(),
    },
    {
      id: "needs-attention",
      name: "Needs Attention",
      builtin: true,
      groupBy: "rig",
      filters: { status: ["blocked", "escalated"] },
      panes: defaultPanes(),
    },
  ];
}

/**
 * Install the built-in views when the store has none, making {@link DEFAULT_VIEW_ID}
 * active. A no-op when any view already exists, so it never clobbers the operator's
 * own views (or re-adds a built-in they deleted while keeping others).
 */
export function seedDefaults(state: SavedViewsState): SavedViewsState {
  if (state.views.length > 0) return state;
  return { version: SAVED_VIEWS_VERSION, views: builtinViews(), activeId: DEFAULT_VIEW_ID };
}
