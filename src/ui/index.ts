// Public surface of the shared view-state helpers (cockpit-1ll.19).
//
// Every tree pane that can be loading / empty / errored — the Beads explorer and
// the Fleet / merge-queue trees (`../views`) — imports from here so the three
// states read the same everywhere. Stays `vscode`-free.
export {
  CONNECTING,
  STATE_LOOK,
  emptyNotice,
  errorNotice,
  loadingNotice,
  type StateNotice,
  type StateTone,
  type ToneLook,
} from "./view-state.ts";
