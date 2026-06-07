// Persistence + defensive migration for the saved-views store (cockpit-0vi).
//
// The store is a single JSON value under one key in VS Code `globalState`. Reads
// go through {@link normalizeState}, which never throws: anything the editor (or a
// hand-edited / older / corrupt store) hands back is coerced into a valid
// {@link SavedViewsState}, dropping junk and seeding the built-in views when the
// result would be empty. That keeps the feature robust across upgrades and makes
// "views persist across reloads" testable without an editor — the glue in
// `src/views/savedViews.ts` only adapts `globalState` to {@link SavedViewsStore}.
import { GROUP_KEYS, type GroupKey } from "../beads/index.ts";
import { emptyState } from "./model.ts";
import { seedDefaults } from "./defaults.ts";
import {
  PANE_IDS,
  SAVED_VIEWS_VERSION,
  type BeadFilterSelection,
  type PaneId,
  type PaneLayout,
  type SavedView,
  type SavedViewsState,
} from "./types.ts";

/** The `globalState` key the store lives under. */
export const STATE_KEY = "savedViews.state";

/**
 * The slice of `vscode.Memento` (globalState) this layer needs. Declared
 * structurally so persistence stays `vscode`-free and a plain object can stand in
 * under test; `context.globalState` satisfies it directly.
 */
export interface SavedViewsStore {
  get(key: string): unknown;
  update(key: string, value: unknown): unknown;
}

const PANE_ID_SET = new Set<string>(PANE_IDS);
const GROUP_KEY_SET = new Set<string>(GROUP_KEYS);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Coerce arbitrary stored data into a clean {@link BeadFilterSelection}. */
function normalizeFilters(raw: unknown): BeadFilterSelection {
  if (!isObject(raw)) return {};
  const out: BeadFilterSelection = {};
  if (typeof raw.text === "string" && raw.text.trim()) out.text = raw.text;
  if (Array.isArray(raw.status)) {
    const status = raw.status.filter((s): s is string => typeof s === "string");
    if (status.length > 0) out.status = status;
  }
  if (typeof raw.rig === "string") out.rig = raw.rig;
  if (typeof raw.assignee === "string") out.assignee = raw.assignee;
  if (typeof raw.type === "string") out.type = raw.type;
  if (typeof raw.priority === "number" && Number.isFinite(raw.priority)) out.priority = raw.priority;
  return out;
}

/**
 * Coerce stored pane data into a full, de-duplicated layout. Unknown/dup pane ids
 * are dropped; any pane the stored layout never mentioned is appended visible in
 * canonical order, so a view saved before a pane existed still surfaces it.
 */
function normalizePanes(raw: unknown): PaneLayout[] {
  const seen = new Set<string>();
  const out: PaneLayout[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isObject(entry)) continue;
      const id = entry.id;
      if (typeof id !== "string" || !PANE_ID_SET.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ id: id as PaneId, visible: entry.visible !== false });
    }
  }
  for (const id of PANE_IDS) {
    if (!seen.has(id)) out.push({ id, visible: true });
  }
  return out;
}

/** Coerce one stored entry into a {@link SavedView}, or null if it is unusable. */
function normalizeView(raw: unknown): SavedView | null {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null;
  if (!id || !name) return null;
  const view: SavedView = {
    id,
    name,
    filters: normalizeFilters(raw.filters),
    panes: normalizePanes(raw.panes),
  };
  if (typeof raw.groupBy === "string" && GROUP_KEY_SET.has(raw.groupBy)) {
    view.groupBy = raw.groupBy as GroupKey;
  }
  if (raw.builtin === true) view.builtin = true;
  return view;
}

/**
 * Coerce arbitrary stored data into a valid {@link SavedViewsState}. Never throws.
 * Drops invalid/duplicate views, nulls a dangling `activeId`, and seeds the
 * built-in views when no usable view survives.
 */
export function normalizeState(raw: unknown): SavedViewsState {
  if (!isObject(raw)) return seedDefaults(emptyState());

  const rawViews = Array.isArray(raw.views) ? raw.views : [];
  const views: SavedView[] = [];
  const ids = new Set<string>();
  for (const entry of rawViews) {
    const view = normalizeView(entry);
    if (!view || ids.has(view.id)) continue;
    ids.add(view.id);
    views.push(view);
  }

  const activeId = typeof raw.activeId === "string" && ids.has(raw.activeId) ? raw.activeId : null;
  return seedDefaults({ version: SAVED_VIEWS_VERSION, views, activeId });
}

/** Read + normalize the store. */
export function loadState(store: SavedViewsStore, key: string = STATE_KEY): SavedViewsState {
  return normalizeState(store.get(key));
}

/** Persist a state value (assumed already valid — it came from the model functions). */
export async function saveState(
  store: SavedViewsStore,
  state: SavedViewsState,
  key: string = STATE_KEY,
): Promise<void> {
  await store.update(key, state);
}
