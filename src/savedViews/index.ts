// Public surface of the saved-views domain layer (cockpit-0vi).
//
// The VS Code glue in `../views/savedViews.ts` imports from here. This barrel
// stays free of `vscode` so the CRUD/validation/persistence logic remains
// unit-testable in plain Node.
export {
  PANES,
  PANE_IDS,
  SAVED_VIEWS_VERSION,
  type BeadFilterSelection,
  type PaneId,
  type PaneLayout,
  type PaneMeta,
  type SavedView,
  type SavedViewsState,
} from "./types.ts";

export {
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
  type CreateViewInput,
  type ViewContentPatch,
} from "./model.ts";

export { DEFAULT_VIEW_ID, builtinViews, seedDefaults } from "./defaults.ts";

export {
  STATE_KEY,
  loadState,
  normalizeState,
  saveState,
  type SavedViewsStore,
} from "./persistence.ts";
