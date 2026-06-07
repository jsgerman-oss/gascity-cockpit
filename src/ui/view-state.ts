// One source of truth for how every Cockpit pane describes the four "no real
// content yet" states — loading, empty, error, and reconnecting (cockpit-1ll.19
// shipped the first three; cockpit-n5p adds reconnecting and the state machine
// in `pane-state.ts` that picks between them).
//
// The .13 polish pass left this corner inconsistent: the Beads explorer, the
// Fleet tree, and the merge-queue each built their own loading/empty/error rows
// with drifting words and icons — "Cannot load beads" vs "Cannot load merge
// queue" vs a raw API error string; the Fleet error row even passed no icon at
// all, so it rendered as a neutral `info` dot instead of the error glyph the
// other panes used. A reader could not tell whether two panes were in the same
// state. The reconnecting tone closed a second gap: when the supervisor dropped
// (`gc stop`, a restart), panes either froze on stale rows or flashed a red
// "couldn't load" — neither said "the link is down and I'm getting it back".
//
// This module is the shared vocabulary: the four tones, the icon/colour each
// tone wears, and factory helpers that bake consistent copy. It is kept free of
// `vscode` so it stays in the Seam-1 test layer; the thin tree glue maps a
// {@link StateNotice} onto a `TreeItem` (icon + colour + description). Panes keep
// their own *empty* copy — an empty merge queue is a cheerful "all clear", an
// empty bead list is a neutral "nothing here" — what unifies is the structure,
// the loading/error/reconnecting wording, and the icon vocabulary. Which tone a
// pane is in — given its data and the live supervisor connection — is decided
// once, in {@link file://./pane-state.ts}, so no pane re-derives it by hand.
//
// (The webviews — chat, dashboard, time-travel — were audited too, but each owns
// a single self-contained state surface that is already internally consistent and
// context-appropriate, so they keep their bespoke copy rather than borrowing a
// tree row's vocabulary.)

/**
 * The coarse "no content" states a data-bearing pane can be in.
 *
 * - `loading` — the first fetch is in flight (or the supervisor link is still
 *   coming up).
 * - `empty` — the fetch succeeded and there is genuinely nothing to show.
 * - `error` — the fetch failed while the supervisor was reachable.
 * - `reconnecting` — the supervisor link dropped; the Cockpit is backing off and
 *   re-discovering, and will recover on its own. Distinct from `error` so a
 *   transient outage reads as "recovering", not "broken".
 */
export type StateTone = "loading" | "empty" | "error" | "reconnecting";

/** The icon (and optional icon colour) a tone wears, shared across panes. */
export interface ToneLook {
  /** VS Code codicon id, without the `$(...)` wrapper. */
  icon: string;
  /** Optional `ThemeColor` id the tree glue tints the icon with. */
  iconColor?: string;
}

/**
 * The canonical look per tone. `loading` spins; `error` is the error glyph in
 * the theme's error colour (matching the Fleet status icons in `status/views`).
 * `empty` is a neutral dot a pane may override with something domain-appropriate
 * (the merge queue's cheerful `check-all`). `reconnecting` spins too — but on the
 * `sync` glyph in the theme's *warning* colour, so it reads as "transient, being
 * worked on" rather than the neutral first-load spinner or the hard error red.
 */
export const STATE_LOOK: Record<StateTone, ToneLook> = {
  loading: { icon: "loading~spin" },
  empty: { icon: "info" },
  error: { icon: "error", iconColor: "list.errorForeground" },
  reconnecting: { icon: "sync~spin", iconColor: "list.warningForeground" },
};

/**
 * A pane-agnostic description of a "no content" row: which tone it is, the words
 * to show, and the resolved icon/colour. The tree glue spreads this onto its own
 * message/notice node.
 */
export interface StateNotice {
  tone: StateTone;
  /** The primary line — what is happening ("Connecting…", "No cities", "Couldn't load …"). */
  label: string;
  /** Optional secondary line — the underlying error, or a hint. */
  detail?: string;
  /** Resolved codicon id (the tone's, unless a pane overrode it). */
  icon: string;
  /** Resolved `ThemeColor` id, when the tone carries one. */
  iconColor?: string;
}

/** The shared "first fetch is in flight" copy, identical wherever a pane connects. */
export const CONNECTING = "Connecting to supervisor…";

/** The shared "the link dropped, getting it back" copy, identical across panes. */
export const RECONNECTING = "Reconnecting to supervisor…";

function make(tone: StateTone, label: string, detail?: string, iconOverride?: string): StateNotice {
  const look = STATE_LOOK[tone];
  const notice: StateNotice = { tone, label, icon: iconOverride ?? look.icon };
  if (detail) notice.detail = detail;
  if (look.iconColor) notice.iconColor = look.iconColor;
  return notice;
}

/**
 * The "first snapshot in flight" row. Defaults to the shared {@link CONNECTING}
 * copy so every pane says the same thing while it waits.
 */
export function loadingNotice(label: string = CONNECTING, detail?: string): StateNotice {
  return make("loading", label, detail);
}

/**
 * A "there is genuinely nothing here" row. The `label` is the pane's own empty
 * copy ("No cities registered", "Merge queue is empty"); pass `icon` to override
 * the neutral dot (e.g. the merge queue's celebratory `check-all`).
 */
export function emptyNotice(label: string, detail?: string, icon?: string): StateNotice {
  return make("empty", label, detail, icon);
}

/**
 * A "the fetch failed" row, worded the same everywhere: `Couldn't load <resource>.`
 * with the raw API error folded into the detail line. Replaces the per-pane
 * "Cannot load X" strings so two failed panes read identically. A dropped
 * supervisor connection arrives here too (its cause rides in the detail), so an
 * unreachable supervisor degrades to a clear, consistent notice.
 */
export function errorNotice(resource: string, detail?: string): StateNotice {
  return make("error", `Couldn't load ${resource}.`, detail);
}

/**
 * A "the supervisor link dropped and the Cockpit is getting it back" row, worded
 * the same everywhere: the shared {@link RECONNECTING} copy with the reason for
 * the drop (e.g. the failed health probe and the backoff) folded into the detail.
 * Distinct from {@link errorNotice} so a transient outage — `gc stop`, a
 * supervisor restart, a city stopping — reads as recovering rather than broken,
 * and it clears on its own once the connection is re-established.
 */
export function reconnectingNotice(detail?: string): StateNotice {
  return make("reconnecting", RECONNECTING, detail);
}
