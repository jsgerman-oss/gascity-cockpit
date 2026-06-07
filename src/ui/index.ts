// Public surface of the shared view-state helpers (cockpit-1ll.19, cockpit-n5p).
//
// Every pane that can be loading / empty / errored / reconnecting — the Beads
// explorer, the Fleet / merge-queue / telemetry trees (`../views`), and the
// docked chat view — imports from here so the four states read the same
// everywhere, and resolves *which* state it is in via {@link resolvePaneState}.
// Stays `vscode`-free.
export {
  CONNECTING,
  RECONNECTING,
  STATE_LOOK,
  emptyNotice,
  errorNotice,
  loadingNotice,
  reconnectingNotice,
  type StateNotice,
  type StateTone,
  type ToneLook,
} from "./view-state.ts";
export {
  connectivityOf,
  resolvePaneState,
  type Connectivity,
  type EmptyCopy,
  type PaneInputs,
  type PaneState,
} from "./pane-state.ts";
