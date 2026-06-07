// Shapes for the "Metrics over time" pane (cockpit-3x7).
//
// A `vscode`-free Seam-1 model (PRD Testing Decisions): the derivation and
// formatting are proven in plain Node; the editor glue (`src/views/metrics.ts`)
// is a thin adapter. The pane reports three bead-lifecycle metrics over a
// selectable window — throughput (issues closed), cycle time (open→closed), and
// the refinery reject rate — broken down per rig and per agent. Everything is
// derived from existing `/v0` event history; see docs/metrics-over-time.md for
// the data sources and the honest gaps filed upstream.

/** Which lifecycle signal a normalized {@link MetricEvent} represents. */
export type MetricEventKind = 'closed' | 'rejected';

/**
 * One normalized, `vscode`-free lifecycle event the derivation consumes. Built
 * from a `/v0` `bead.closed` envelope (a merge/close) or a `bead.updated`
 * envelope that carries a refinery `rejection_reason` (a reject).
 */
export interface MetricEvent {
  kind: MetricEventKind;
  /** Event time — the close time or reject time — as epoch milliseconds. */
  tsMs: number;
  /** The bead the event is about. */
  beadId: string;
  /** Resolved rig name, or {@link UNSCOPED_RIG} when no prefix matches. */
  rig: string;
  /** Resolved agent identity, or {@link UNATTRIBUTED} when none is recorded. */
  agent: string;
  /** City the event came from (events are city-scoped in `/v0`). */
  city: string;
  /** Bead creation time for cycle-time (closed events); epoch ms, or null. */
  createdAtMs: number | null;
  /** Rejection reason (rejected events) — used to de-dupe rejection episodes. */
  rejectionReason: string | null;
}

/** A selectable reporting window id. */
export type MetricWindowId = '24h' | '7d' | '30d';

/**
 * A reporting window. Sized in **hours** because the `/v0` `since` filter takes a
 * Go duration string, which has no day unit (7d is requested as `168h`).
 */
export interface MetricWindow {
  id: MetricWindowId;
  /** Human label, e.g. "Last 7 days". */
  label: string;
  /** Window span in hours. */
  hours: number;
  /** How many time buckets the throughput sparkline is split into. */
  buckets: number;
  /** Short label for one bucket, e.g. "hr" or "day". */
  bucketUnit: string;
}

/** Which dimension the panes group by. */
export type MetricGroupBy = 'rig' | 'agent';

/** Cycle-time summary for a group: open→closed durations, in ms. */
export interface CycleStats {
  count: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
}

/** Refinery reject summary for a group. */
export interface RejectStats {
  /** Distinct rejection episodes in the window. */
  rejects: number;
  /** Successful merges (work-bead closes) in the window. */
  merges: number;
  /** `rejects / (rejects + merges)`, or null when there were no submissions. */
  rate: number | null;
}

/** Throughput for a group: total closes plus a time-bucketed series. */
export interface ThroughputStats {
  total: number;
  /** Per-bucket counts, oldest→newest; length === the window's bucket count. */
  series: number[];
}

/** All three metrics for one group — a rig, an agent, or the overall total. */
export interface GroupMetrics {
  /** Stable key (rig name, agent identity, or "overall"). */
  id: string;
  /** Display label. */
  label: string;
  throughput: ThroughputStats;
  /** Cycle-time stats, or null when no closed bead in the window had a creation time. */
  cycle: CycleStats | null;
  reject: RejectStats;
}

/** The derived model the panes render. */
export interface MetricsModel {
  /** The window this model was derived for. */
  window: MetricWindow;
  /** Inclusive end of the window (the "now" the derivation used), epoch ms. */
  nowMs: number;
  /** Overall totals across every group. */
  overall: GroupMetrics;
  /** Per-rig groups, busiest (highest throughput) first. */
  byRig: GroupMetrics[];
  /** Per-agent groups, busiest first. */
  byAgent: GroupMetrics[];
}

/** Loading lifecycle of the metrics pane. */
export type MetricsPhase = 'idle' | 'loading' | 'ready' | 'error';

/** The observable state the tree view renders from. */
export interface MetricsState {
  phase: MetricsPhase;
  windowId: MetricWindowId;
  groupBy: MetricGroupBy;
  model: MetricsModel | null;
  /**
   * True when coverage was capped or a city errored — the numbers are a floor,
   * not a complete count. The pane surfaces this so totals are never overclaimed.
   */
  partial: boolean;
  /** When the current model was fetched, epoch ms, or null. */
  fetchedAtMs: number | null;
  /** The raw error detail when `phase === 'error'`, else null. */
  errorDetail: string | null;
}

/** A bead-id-prefix → rig-name index, used to attribute a bead to its rig. */
export interface RigIndex {
  /** e.g. `"cockpit"` → `"gascity-cockpit"`. */
  byPrefix: Map<string, string>;
}

/** The outcome of {@link MetricEvent} attribution for one bead/actor pair. */
export interface Attribution {
  rig: string;
  agent: string;
}
