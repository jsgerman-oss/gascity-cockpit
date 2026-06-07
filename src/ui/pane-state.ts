// The cross-pane state machine (cockpit-n5p).
//
// `view-state.ts` is the *vocabulary* — the four tones and the rows that wear
// them. This module is the *grammar*: given what a pane has (rows? a fetch
// error? a first load still in flight?) and the live supervisor connection, it
// decides which single state the pane is in, so every pane resolves "what do I
// show right now" the same way instead of each re-deriving it with a bespoke
// `if (error) … else if (loading) …` ladder.
//
// Why a separate machine. The connection is its own seven-state lifecycle
// (`discovery/connection.ts`: idle → discovering → connecting → connected ⇄
// degraded ⇄ reconnecting → unavailable). A pane does not care about all seven;
// it cares about three things — is the link *coming up*, *live*, or *lost* — and
// crosses that with its own data. The crossing is where panes used to drift:
// when the supervisor dropped, some froze on stale rows, some flashed a red
// "couldn't load", none said "reconnecting". {@link resolvePaneState} folds the
// seven connection states down to {@link Connectivity} and applies one ordering,
// so an API-down / city-stopped outage degrades to the same reconnecting row
// everywhere and recovers on its own when the link returns.
//
// Kept `vscode`-free (Seam 1): it takes plain data in and returns a
// {@link StateNotice}, so it is unit-tested without an editor and the thin tree /
// webview glue just renders the result.
import type { ConnectionState } from "../discovery/types.ts";
import {
  emptyNotice,
  errorNotice,
  loadingNotice,
  reconnectingNotice,
  type StateNotice,
} from "./view-state.ts";

/**
 * What a pane needs to know about the supervisor link — the seven
 * {@link ConnectionState}s projected onto the three that change what a pane
 * shows:
 *
 * - `starting` — the link is being established (or the server is mid-startup);
 *   the pane cannot have data yet, so it waits.
 * - `live` — the link is up and ready; the pane's own data state decides.
 * - `lost` — the link dropped and the Cockpit is backing off + re-discovering;
 *   the pane degrades to a reconnecting row and recovers when the link returns.
 */
export type Connectivity = "starting" | "live" | "lost";

/**
 * Fold a {@link ConnectionState} down to the {@link Connectivity} a pane reacts
 * to. `connected` is the only `live` state; the loss states (`reconnecting`,
 * `unavailable`) are both `lost` — `unavailable` is just `reconnecting` that has
 * been retrying long enough to cross the attempt threshold, and to a pane both
 * mean "the link is down, hold on"; everything else (`idle`, `discovering`,
 * `connecting`, and the up-but-not-ready `degraded`) is the link still
 * `starting`.
 */
export function connectivityOf(state: ConnectionState): Connectivity {
  switch (state) {
    case "connected":
      return "live";
    case "reconnecting":
    case "unavailable":
      return "lost";
    case "idle":
    case "discovering":
    case "connecting":
    case "degraded":
    default:
      return "starting";
  }
}

/** A pane's own empty-state copy — the one piece the shared machine can't word. */
export interface EmptyCopy {
  /** The "there is genuinely nothing here" line ("No agents", "Merge queue is empty"). */
  label: string;
  /** Optional secondary line. */
  detail?: string;
  /** Optional codicon override for the empty row (e.g. the merge queue's `check-all`). */
  icon?: string;
}

/** Everything the machine needs to place a pane in exactly one state. */
export interface PaneInputs {
  /** The supervisor link, projected via {@link connectivityOf}. */
  connectivity: Connectivity;
  /** The pane's first data fetch is still in flight (only meaningful while `live`). */
  loading: boolean;
  /** The pane is holding rows it could render right now (possibly stale). */
  hasContent: boolean;
  /**
   * The pane's last error. While `live` this is a genuine fetch failure; while
   * `lost` it is the reason the link dropped (the failed probe + backoff), folded
   * into the reconnecting row's detail. Absent/empty when there is none.
   */
  error?: string | null;
  /** What the pane loads, for the shared error copy ("beads", "the fleet"). */
  resource: string;
  /** The pane's own empty-state copy. */
  empty: EmptyCopy;
}

/**
 * The pane's resolved state: either render your content as-is, or render this one
 * shared notice. `overlay` distinguishes the single case where the notice rides
 * *with* retained content rather than replacing it — a lost link while the pane
 * still holds (now-stale) rows, so the operator keeps reading them under a
 * reconnecting banner instead of watching the pane blank out on every blip.
 */
export type PaneState =
  | { kind: "ready" }
  | { kind: "notice"; notice: StateNotice; overlay: boolean };

const READY: PaneState = { kind: "ready" };

/**
 * Place a pane in exactly one state. The ordering is the whole point:
 *
 * 1. **Lost link wins.** A dropped supervisor is surfaced as `reconnecting`
 *    regardless of any pane-local fetch error (that error is just the drop's
 *    symptom). With rows in hand the notice is an `overlay` — keep showing the
 *    stale rows, banner the reconnect over them; with nothing to show it stands
 *    in for the content. Either way it clears itself when the link returns.
 * 2. **Coming up.** While the link is still establishing, the pane can't have
 *    fresh data; show the shared loading row (or keep prior rows if it has them).
 * 3. **Live — the pane's own data decides.** A fetch error, then a first load in
 *    flight, then "has rows", then genuinely empty.
 *
 * Returns {@link READY} (render content) whenever the pane has rows and no lost
 * link — stale-but-useful beats a spinner.
 */
export function resolvePaneState(input: PaneInputs): PaneState {
  const { connectivity, loading, hasContent, error, resource, empty } = input;

  if (connectivity === "lost") {
    return { kind: "notice", notice: reconnectingNotice(error ?? undefined), overlay: hasContent };
  }

  if (connectivity === "starting") {
    return hasContent ? READY : notice(loadingNotice());
  }

  // live
  if (hasContent) return READY;
  if (error) return notice(errorNotice(resource, error));
  if (loading) return notice(loadingNotice());
  return notice(emptyNotice(empty.label, empty.detail, empty.icon));
}

function notice(n: StateNotice): PaneState {
  return { kind: "notice", notice: n, overlay: false };
}
