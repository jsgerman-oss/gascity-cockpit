// Run a structured fleet query against the multi-city dataset (cockpit-21l.1).
//
// The executor is the second half of the parse → run pipeline and is just as
// `vscode`-free: it resolves the query's city scope against the live city list,
// then defers all the actual selection to the explorer's tested core
// (`filterRecords`, `sortRecords`, `deriveDisplayStatus`). Keeping the predicate
// logic in one place means the palette and the explorer can never disagree about
// what "blocked" means.
import { deriveDisplayStatus, filterRecords, sortRecords } from "../beads/index.ts";
import type { BeadRecord, DisplayStatus, ExplorerData } from "../beads/index.ts";
import type { FleetQuery } from "./types.ts";

/** One result: a record, its city, and the derived display status to render. */
export interface FleetResultRow {
  city: string;
  record: BeadRecord;
  displayStatus: DisplayStatus;
}

/** The outcome of running a fleet query, with enough context for the palette UI. */
export interface FleetQueryResult {
  /** Matching rows, ranked most-actionable first and truncated to `query.limit`. */
  rows: FleetResultRow[];
  /** The cities actually searched after scope resolution. */
  scopedCities: string[];
  /** Total matches before any `limit` truncation. */
  totalMatched: number;
  /** True when `query.limit` hid some matches. */
  truncated: boolean;
  /** Set when the query named a city that matched no known city. */
  unknownCity: string | null;
}

/** Resolve a scope token against the known city names. */
function resolveScope(cities: string[], scope: string | null): { matched: string[]; unknown: string | null } {
  if (scope === null) return { matched: cities, unknown: null };
  const needle = scope.toLowerCase();
  const exact = cities.filter((c) => c.toLowerCase() === needle);
  if (exact.length > 0) return { matched: exact, unknown: null };
  const partial = cities.filter((c) => c.toLowerCase().includes(needle));
  if (partial.length > 0) return { matched: partial, unknown: null };
  return { matched: [], unknown: scope };
}

/**
 * Execute a {@link FleetQuery} over an {@link ExplorerData} snapshot. Pure: the
 * caller loads the data (across all cities) once and can re-run this on every
 * keystroke. `now` is injectable so `defer_until` derivation is testable.
 */
export function runFleetQuery(data: ExplorerData, query: FleetQuery, now: Date = new Date()): FleetQueryResult {
  const { matched, unknown } = resolveScope(data.cities.map((c) => c.city), query.cityScope);
  const inScope = new Set(matched);

  const records = data.cities.filter((c) => inScope.has(c.city)).flatMap((c) => c.records);
  const filtered = filterRecords(records, query.filters, now);
  const ranked = sortRecords(filtered, now);
  const limited = query.limit && query.limit > 0 ? ranked.slice(0, query.limit) : ranked;

  return {
    rows: limited.map((record) => ({ city: record.city, record, displayStatus: deriveDisplayStatus(record, now) })),
    scopedCities: matched,
    totalMatched: filtered.length,
    truncated: limited.length < filtered.length,
    unknownCity: unknown,
  };
}
