// Domain model for Saved Views & custom dashboards (cockpit-0vi).
//
// A *saved view* is a named, persisted snapshot of how the operator wants the
// cockpit to look: a bead filter selection (the dimensions the Beads explorer
// already filters by) plus which of the activity-bar panes they care about and
// in what order. Switching views re-applies the filter to the Beads explorer and
// surfaces the chosen panes.
//
// Like the rest of `src/<domain>/`, this layer is free of `vscode` so the CRUD,
// validation, and persistence logic is unit-tested in plain Node; the thin editor
// glue (status-bar item, quick-picks, applying a view) lives in
// `src/views/savedViews.ts`. The shape stored in `globalState` is `SavedViewsState`
// — versioned so a future change can migrate it (see `../savedViews/persistence`).
import type { GroupKey } from "../beads/index.ts";

/** Schema version of the persisted {@link SavedViewsState}. Bump on a breaking shape change. */
export const SAVED_VIEWS_VERSION = 1;

/**
 * The activity-bar panes a saved view can select and order. These mirror the
 * view ids contributed into the `gascityCockpit` container (package.json /
 * `src/features/*.contributes.json`); the guard in `contributes.test.ts` pins
 * that set, and {@link PANES} carries the matching `viewId` + label.
 */
export type PaneId = "chatView" | "fleet" | "events" | "beads" | "telemetry" | "mergeQueue";

/** Static metadata for one cockpit pane: its stable id, full view id, and label. */
export interface PaneMeta {
  readonly id: PaneId;
  /** The contributed VS Code view id (`<container>.<pane>`); `<viewId>.focus` reveals it. */
  readonly viewId: string;
  /** Human label shown in the saved-view editor and quick-picks. */
  readonly label: string;
}

/**
 * Every cockpit pane, in the activity-bar order. The canonical default layout —
 * {@link defaultPanes} builds a layout from this, all panes visible.
 */
export const PANES: readonly PaneMeta[] = [
  { id: "chatView", viewId: "gascityCockpit.chatView", label: "Mayor" },
  { id: "fleet", viewId: "gascityCockpit.fleet", label: "Fleet" },
  { id: "events", viewId: "gascityCockpit.events", label: "Event Feed" },
  { id: "beads", viewId: "gascityCockpit.beads", label: "Beads" },
  { id: "telemetry", viewId: "gascityCockpit.telemetry", label: "Cost & Tier" },
  { id: "mergeQueue", viewId: "gascityCockpit.mergeQueue", label: "Merge Queue" },
];

/** Just the pane ids, in canonical order. */
export const PANE_IDS: readonly PaneId[] = PANES.map((p) => p.id);

/**
 * The bead-filter dimensions a saved view captures (cockpit-0vi acceptance:
 * status, rig, assignee, type, priority — plus the free-text search). A serializable
 * subset of `BeadFilters`: the global toggles `includeClosed` / `hideOperational`
 * are deliberately omitted — they stay the operator's session-wide switches, not
 * something a view silently flips — so applying a view never needs a refetch
 * (every field here filters the already-loaded records client-side).
 */
export interface BeadFilterSelection {
  /** Case-insensitive substring matched against bead id and title. */
  text?: string;
  /** Keep only beads whose derived display status is in this set. */
  status?: string[];
  /** Exact rig. */
  rig?: string;
  /** Exact assignee; the empty string matches unassigned beads. */
  assignee?: string;
  /** Exact issue type. */
  type?: string;
  /** Exact numeric priority. */
  priority?: number;
}

/** One pane's place in a saved view: its id, whether it is selected, in list order. */
export interface PaneLayout {
  id: PaneId;
  /** When true the pane is surfaced (revealed/focused) on switch; when false it is left alone. */
  visible: boolean;
}

/** A named, persisted cockpit view: a bead filter + grouping + pane selection/layout. */
export interface SavedView {
  /** Stable unique id (slug derived from the name at creation; survives rename). */
  id: string;
  /** Operator-facing name. */
  name: string;
  /** Beads grouping to apply, or undefined to leave the current grouping. */
  groupBy?: GroupKey;
  /** Bead filter dimensions to apply. */
  filters: BeadFilterSelection;
  /** Pane selection + order. */
  panes: PaneLayout[];
  /** True for the shipped default views (seeded on first run). */
  builtin?: boolean;
}

/** The whole persisted saved-views store (the value under one `globalState` key). */
export interface SavedViewsState {
  /** {@link SAVED_VIEWS_VERSION} the store was written at. */
  version: number;
  /** All saved views, in display order. */
  views: SavedView[];
  /** The currently-applied view id, or null when none is active. */
  activeId: string | null;
}
