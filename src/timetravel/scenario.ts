// Replay-to-regression scenarios for event time-travel (cockpit-6x0).
//
// A `vscode`-free layer (Seam 1) built on the {@link EventTimeline} domain store.
// Time-travel records the supervisor event feed and derives a {@link
// TimelineSnapshot} (chronological, de-duped, capped, projected rows). A *replay
// scenario* freezes one such window — the recorded event sequence plus the exact
// derived state it produced — as an in-repo fixture. A runner replays the events
// back through a fresh `EventTimeline` and asserts the derived state has not
// drifted, turning a captured run into a regression test for the recorder + its
// projection (`recorder.ts` de-dup/cap, `view.ts` presentation).
//
// The capture and run paths share one code path (`captureScenario` replays to
// derive `expected`; `runScenario` replays to compare), so a freshly captured
// scenario always passes — the regression value comes from the fixture's
// `expected` being committed and frozen. If the recorder or projection later
// changes the derived state, the runner re-derives a different snapshot and the
// frozen expectation no longer matches: drift, caught in CI.
import { EventTimeline, TIMELINE_CAP } from './recorder.ts';
import type { FleetEvent, TimelineBounds, TimelineRow, TimelineSnapshot } from './types.ts';

/**
 * On-disk format version. Bump only on an incompatible shape change so an old
 * fixture fails loudly in {@link coerceScenario} instead of mis-replaying.
 */
export const SCENARIO_FORMAT_VERSION = 1;

/**
 * A frozen replay window: the recorded event sequence and the derived state it
 * produced. Serialized to a JSON fixture and replayed by {@link runScenario}.
 */
export interface ReplayScenario {
  /** Format version, validated on load ({@link SCENARIO_FORMAT_VERSION}). */
  version: number;
  /** Operator-given name; the scenario's stable identity in test output. */
  name: string;
  /** Optional note: what this run captured and why it is worth guarding. */
  description?: string;
  /** Optional RFC3339 capture time. Informational — never asserted. */
  capturedAt?: string;
  /**
   * The recorder cap in force when captured. The runner replays with the same
   * cap so eviction reproduces; a window with overflow exercises the ring.
   */
  cap: number;
  /** The recorded event sequence, oldest first (may include reconnect dupes). */
  events: FleetEvent[];
  /** The derived state the recorder produced from {@link events} at capture. */
  expected: TimelineSnapshot;
}

/** Optional metadata recorded alongside a captured scenario. */
export interface CaptureOptions {
  description?: string;
  capturedAt?: string;
  /** Override the replay cap (defaults to {@link TIMELINE_CAP}). */
  cap?: number;
}

/** A serializable copy of an event with only its defined fields, for tidy JSON. */
function cloneEvent(e: FleetEvent): FleetEvent {
  return {
    seq: e.seq,
    type: e.type,
    ts: e.ts,
    actor: e.actor,
    city: e.city,
    ...(e.subject !== undefined ? { subject: e.subject } : {}),
    ...(e.message !== undefined ? { message: e.message } : {}),
    ...(e.cursor !== undefined ? { cursor: e.cursor } : {}),
  };
}

/**
 * Build a scenario from a raw recorded event sequence by replaying it through a
 * fresh {@link EventTimeline} and snapshotting the derived state. The input
 * `events` are stored verbatim (a duplicate- or overflow-bearing sequence is
 * preserved so the fixture exercises the recorder's de-dup/cap), while
 * `expected` is whatever the recorder derives from them now.
 */
export function captureScenario(
  name: string,
  events: readonly FleetEvent[],
  opts: CaptureOptions = {},
): ReplayScenario {
  const cap = opts.cap ?? TIMELINE_CAP;
  const timeline = new EventTimeline(cap);
  for (const e of events) timeline.record(e);
  return {
    version: SCENARIO_FORMAT_VERSION,
    name,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.capturedAt !== undefined ? { capturedAt: opts.capturedAt } : {}),
    cap,
    events: events.map(cloneEvent),
    expected: timeline.snapshot(),
  };
}

/**
 * Capture a scenario straight from a live recorder — the replay/scrub UI's
 * background {@link EventTimeline}. Uses the recorder's current window and cap;
 * any {@link CaptureOptions} (e.g. an explicit cap) override the defaults.
 */
export function captureTimelineScenario(
  timeline: EventTimeline,
  name: string,
  opts: CaptureOptions = {},
): ReplayScenario {
  return captureScenario(name, timeline.events(), { cap: timeline.capacity, ...opts });
}

/** Outcome of replaying a scenario: clean, or a list of human-readable drifts. */
export interface ScenarioDrift {
  /** The scenario's name, echoed for test output. */
  scenario: string;
  /** True when the replayed derived state matches the frozen expectation. */
  ok: boolean;
  /** One message per mismatch; empty when {@link ok}. */
  drift: string[];
}

/**
 * Replay a scenario's events through a fresh {@link EventTimeline} (the domain
 * store) and compare the derived snapshot to the frozen expectation. Pure: never
 * throws on drift — it returns a structured result so a test can assert on it.
 */
export function runScenario(scenario: ReplayScenario): ScenarioDrift {
  const timeline = new EventTimeline(scenario.cap);
  for (const e of scenario.events) timeline.record(e);
  const drift = diffSnapshots(scenario.expected, timeline.snapshot());
  return { scenario: scenario.name, ok: drift.length === 0, drift };
}

/** Render bounds for a drift message. */
function formatBounds(bounds: TimelineBounds | null): string {
  return bounds === null ? 'none' : JSON.stringify(bounds);
}

/** Structural equality for two bounds (or nulls). */
function boundsEqual(a: TimelineBounds | null, b: TimelineBounds | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.count === b.count &&
    a.firstSeq === b.firstSeq &&
    a.lastSeq === b.lastSeq &&
    a.firstTs === b.firstTs &&
    a.lastTs === b.lastTs
  );
}

/** Every field of a projected row, compared one-by-one for precise drift output. */
const ROW_FIELDS: readonly (keyof TimelineRow)[] = [
  'seq', 'type', 'ts', 'actor', 'city', 'subject', 'message', 'label', 'desc', 'kind',
];

/** Per-field differences between two rows, as `field: expected … but got …`. */
function diffRow(expected: TimelineRow, actual: TimelineRow): string[] {
  const out: string[] = [];
  for (const field of ROW_FIELDS) {
    if (expected[field] !== actual[field]) {
      out.push(`${field}: expected ${JSON.stringify(expected[field])} but got ${JSON.stringify(actual[field])}`);
    }
  }
  return out;
}

/**
 * Compare two derived snapshots and describe every mismatch. Reports bounds and
 * row-count drift, then per-row/per-field drift across the overlapping rows.
 */
export function diffSnapshots(expected: TimelineSnapshot, actual: TimelineSnapshot): string[] {
  const drift: string[] = [];
  if (!boundsEqual(expected.bounds, actual.bounds)) {
    drift.push(`bounds: expected ${formatBounds(expected.bounds)} but got ${formatBounds(actual.bounds)}`);
  }
  if (expected.rows.length !== actual.rows.length) {
    drift.push(`row count: expected ${expected.rows.length} but got ${actual.rows.length}`);
  }
  const overlap = Math.min(expected.rows.length, actual.rows.length);
  for (let i = 0; i < overlap; i++) {
    for (const d of diffRow(expected.rows[i], actual.rows[i])) drift.push(`row ${i} ${d}`);
  }
  return drift;
}

/** Pretty-print a scenario as the canonical fixture JSON (2-space, trailing newline). */
export function serializeScenario(scenario: ReplayScenario): string {
  return `${JSON.stringify(scenario, null, 2)}\n`;
}

/** Narrow an unknown to a plain (non-array) object, or throw a labelled error. */
function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Validate an already-parsed value as a {@link ReplayScenario}. Used both to load
 * imported JSON fixtures and (via {@link parseScenario}) to load files at runtime.
 * The nested event/row shapes are not deep-checked: the runner re-derives the
 * rows from the events and compares structurally, so a malformed item surfaces as
 * drift rather than silently passing.
 */
export function coerceScenario(value: unknown): ReplayScenario {
  const o = asObject(value, 'scenario');
  if (o.version !== SCENARIO_FORMAT_VERSION) {
    throw new Error(`unsupported scenario version ${String(o.version)} (expected ${SCENARIO_FORMAT_VERSION})`);
  }
  if (typeof o.name !== 'string' || o.name.length === 0) {
    throw new Error('scenario.name must be a non-empty string');
  }
  if (typeof o.cap !== 'number' || !Number.isInteger(o.cap) || o.cap <= 0) {
    throw new Error('scenario.cap must be a positive integer');
  }
  if (!Array.isArray(o.events)) {
    throw new Error('scenario.events must be an array');
  }
  const expected = asObject(o.expected, 'scenario.expected');
  if (!Array.isArray(expected.rows)) {
    throw new Error('scenario.expected.rows must be an array');
  }
  if (expected.bounds !== null && typeof expected.bounds !== 'object') {
    throw new Error('scenario.expected.bounds must be an object or null');
  }
  return {
    version: SCENARIO_FORMAT_VERSION,
    name: o.name,
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    ...(typeof o.capturedAt === 'string' ? { capturedAt: o.capturedAt } : {}),
    cap: o.cap,
    events: o.events as FleetEvent[],
    expected: { rows: expected.rows as TimelineRow[], bounds: expected.bounds as TimelineBounds | null },
  };
}

/** Parse and validate a scenario from its JSON text. Throws on malformed input. */
export function parseScenario(json: string): ReplayScenario {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new Error(`scenario is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return coerceScenario(value);
}
