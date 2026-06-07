// Pure CRUD + selection logic for saved views (cockpit-0vi).
//
// Every function is total and immutable: it takes a {@link SavedViewsState} and
// returns a new one, never mutating the input, so the editor glue can keep the
// live state in one place and the tests can reason about transitions without
// fixtures. `vscode`-free — the persistence adapter and editor wiring live
// elsewhere (`./persistence`, `../views/savedViews.ts`).
import type { GroupKey } from "../beads/index.ts";
import {
  PANE_IDS,
  SAVED_VIEWS_VERSION,
  type BeadFilterSelection,
  type PaneLayout,
  type SavedView,
  type SavedViewsState,
} from "./types.ts";

/** A fresh, empty store at the current schema version. */
export function emptyState(): SavedViewsState {
  return { version: SAVED_VIEWS_VERSION, views: [], activeId: null };
}

/** The canonical "all panes shown" layout, in activity-bar order. */
export function defaultPanes(): PaneLayout[] {
  return PANE_IDS.map((id) => ({ id, visible: true }));
}

/** Copy a pane layout array, narrowing each entry to its two fields (no shared refs). */
function clonePanes(panes: PaneLayout[]): PaneLayout[] {
  return panes.map((p) => ({ id: p.id, visible: p.visible }));
}

/** Slugify a name into an id stem: lowercase, non-alphanumerics → `-`, trimmed. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "view";
}

/** Return `base`, or `base-2`, `base-3`, … — the first not already in `taken`. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

/** Trim a view name; throw if it is empty/whitespace. */
export function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Saved view name cannot be empty.");
  return trimmed;
}

/** Fields accepted when creating a view. `panes` defaults to {@link defaultPanes}. */
export interface CreateViewInput {
  name: string;
  groupBy?: GroupKey;
  filters?: BeadFilterSelection;
  panes?: PaneLayout[];
}

/** Append a new view (id derived from its name, unique within the store). */
export function createView(
  state: SavedViewsState,
  input: CreateViewInput,
): { state: SavedViewsState; view: SavedView } {
  const name = normalizeName(input.name);
  const id = uniqueId(
    slugify(name),
    state.views.map((v) => v.id),
  );
  const view: SavedView = {
    id,
    name,
    filters: { ...(input.filters ?? {}) },
    panes: input.panes ? clonePanes(input.panes) : defaultPanes(),
  };
  if (input.groupBy) view.groupBy = input.groupBy;
  return { state: { ...state, views: [...state.views, view] }, view };
}

/** Rename a view by id. Throws if no view has that id. */
export function renameView(state: SavedViewsState, id: string, name: string): SavedViewsState {
  const newName = normalizeName(name);
  let found = false;
  const views = state.views.map((v) => {
    if (v.id !== id) return v;
    found = true;
    return { ...v, name: newName };
  });
  if (!found) throw new Error(`No saved view with id "${id}".`);
  return { ...state, views };
}

/** Delete a view by id. Idempotent; clears `activeId` if the active view is removed. */
export function deleteView(state: SavedViewsState, id: string): SavedViewsState {
  return {
    ...state,
    views: state.views.filter((v) => v.id !== id),
    activeId: state.activeId === id ? null : state.activeId,
  };
}

/** Set (or clear, with `null`) the active view. Throws if `id` names no view. */
export function setActiveView(state: SavedViewsState, id: string | null): SavedViewsState {
  if (id !== null && !state.views.some((v) => v.id === id)) {
    throw new Error(`No saved view with id "${id}".`);
  }
  return { ...state, activeId: id };
}

/** Fields that can overwrite a view's captured content (used by "Update to current"). */
export interface ViewContentPatch {
  groupBy?: GroupKey;
  filters?: BeadFilterSelection;
  panes?: PaneLayout[];
}

/** Overwrite a view's grouping/filters/panes. Throws if no view has that id. */
export function updateViewContent(
  state: SavedViewsState,
  id: string,
  patch: ViewContentPatch,
): SavedViewsState {
  let found = false;
  const views = state.views.map((v) => {
    if (v.id !== id) return v;
    found = true;
    const updated: SavedView = { ...v };
    if (patch.filters) updated.filters = { ...patch.filters };
    if (patch.panes) updated.panes = clonePanes(patch.panes);
    if (patch.groupBy !== undefined) updated.groupBy = patch.groupBy;
    return updated;
  });
  if (!found) throw new Error(`No saved view with id "${id}".`);
  return { ...state, views };
}

/** Look up a view by id. */
export function getView(state: SavedViewsState, id: string): SavedView | undefined {
  return state.views.find((v) => v.id === id);
}

/** The active view, or null when none is active (or the active id dangles). */
export function getActiveView(state: SavedViewsState): SavedView | null {
  return state.activeId === null ? null : (getView(state, state.activeId) ?? null);
}
