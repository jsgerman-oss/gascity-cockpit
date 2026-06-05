// Domain model for the fleet command palette (cockpit-21l.1).
//
// The palette turns a plain-language request ("blocked beads in cockpit") into a
// structured query that runs across every city. The query is deliberately the
// Beads explorer's own {@link BeadFilters} predicate plus a city scope, so the
// parser and executor reuse the tested filtering/derivation core in `../beads`
// rather than reinventing it. No `vscode` import — this whole layer is the
// Seam-1 surface, unit-tested in plain Node (PRD Testing Decisions).
import type { BeadFilters } from "../beads/index.ts";

/**
 * A structured fleet query: a bead predicate plus a city scope.
 *
 * `filters` is the exact shape the explorer filters records with, so a parsed
 * query feeds straight into `filterRecords`. `cityScope` stays a raw token (e.g.
 * "cockpit") rather than a resolved name because the live city list is only
 * known at execution time — "cockpit" should match "gascity-cockpit" against
 * whatever cities the supervisor currently serves.
 */
export interface FleetQuery {
  /** Reuses the explorer's predicate: status / type / priority / assignee / text / includeClosed. */
  filters: BeadFilters;
  /** City scope token as written, or `null` for the fleet-wide default (all cities). */
  cityScope: string | null;
  /** Optional cap on returned rows ("top 10"); `undefined` = no cap. */
  limit?: number;
}

/**
 * The outcome of parsing a natural-language query string. `summary` is a
 * deterministic restatement the palette echoes back ("Interpreted as…") so the
 * resolution is always explainable; `unmatched` carries any significant words
 * the parser did not understand, for a gentle hint.
 */
export interface ParsedFleetQuery {
  /** The original input, trimmed. */
  input: string;
  /** The structured query to execute. */
  query: FleetQuery;
  /** One-line, human-readable restatement of the query. */
  summary: string;
  /** Significant words the parser did not map to any constraint. */
  unmatched: string[];
}
