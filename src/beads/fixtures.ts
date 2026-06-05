// Test fixtures for the beads domain layer. Not a `*.test.ts` file, so vitest
// does not collect it as a suite — it is imported freely by the suites.
import type { Bead, BeadGraphResponse, BeadRecord } from "./types.ts";

/** Build a Bead with sensible defaults; override only what a test cares about. */
export function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: "b-1",
    title: "A bead",
    status: "open",
    issue_type: "task",
    created_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

/** Wrap a bead as a city-scoped record. */
export function makeRecord(overrides: Partial<Bead> = {}, ready: boolean | null = null, city = "alpha"): BeadRecord {
  return { city, bead: makeBead(overrides), ready };
}

export function makeGraph(overrides: Partial<BeadGraphResponse> = {}): BeadGraphResponse {
  const root = overrides.root ?? makeBead({ id: "root", title: "Root" });
  return {
    root,
    beads: overrides.beads ?? [root],
    deps: overrides.deps ?? [],
  };
}
