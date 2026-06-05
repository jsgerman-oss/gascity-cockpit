// Shared presentation helpers for a single city across every Cockpit pane.
//
// Multi-city handling was spread across the panes: the Fleet tree, the Beads
// explorer, and the chat city-picker each computed a city's run-state text and
// the "connecting / no cities" placeholders their own slightly-different way, so
// the same city read differently depending on where you looked (cockpit-1ll.16).
// This is the one source of truth — kept free of `vscode` so it stays in the
// Seam-1 test layer; the editor glue maps these strings onto TreeItems/QuickPick
// rows.
import type { CityInfo } from "../api/index.ts";

/** Coarse run-state of a city, used to pick an icon/severity in the glue. */
export type CityStatusKind = "running" | "stopped" | "error";

/**
 * Classify a city: an `error` dominates (we couldn't talk to it), otherwise it
 * is running or stopped. Each pane maps this onto its own icon vocabulary.
 */
export function cityStatusKind(city: CityInfo): CityStatusKind {
  if (city.error) return "error";
  return city.running ? "running" : "stopped";
}

/**
 * A short, human status phrase for a city, identical wherever a city is shown.
 *
 * `detail: true` folds the error message into the phrase (`error: <msg>`) for
 * surfaces with room — the chat QuickPick row, a screen-reader label. The
 * default stays terse (`error`, `running`, `stopped`, `stopped · <status>`) so
 * it fits a tree-item description.
 */
export function cityStatusText(city: CityInfo, opts: { detail?: boolean } = {}): string {
  if (city.error) return opts.detail ? `error: ${city.error}` : "error";
  if (city.running) return city.status || "running";
  return city.status ? `stopped · ${city.status}` : "stopped";
}

/**
 * The placeholder rows every city-bearing pane shows when there is nothing to
 * list yet. Shared so the Fleet tree, Beads explorer, and chat fallback all use
 * the same words — "connecting" while the first fetch is in flight, "no cities"
 * once it returns empty.
 */
export const CITY_PLACEHOLDER = {
  connecting: "Connecting to supervisor…",
  noCities: "No cities registered",
} as const;
