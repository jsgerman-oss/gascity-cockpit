// Domain model for the cost & tier telemetry panes (cockpit-21l.3).
//
// A `vscode`-free Seam-1 layer (PRD Testing Decisions), mirroring the live
// status feature: a provider-agnostic store fed by the supervisor SSE event
// stream. The only telemetry the /v0 contract exposes per (agent, bead, model)
// is the `worker.operation` event; this module normalises it and rolls it up.
//
// The contract is deliberately forward-looking. `worker.operation` already
// carries token and cost fields, but the supervisor marks them "currently always
// absent" (see WorkerOperationEventPayload in the generated spec, and #1255 for
// the pricing seam). We bind to them now and render them as "not measured" until
// upstream populates them — the surface lights up with zero cockpit changes the
// moment the data lands. Model-advisor *tier decisions* are not in /v0 at all;
// that gap is tracked by an upstream bead (see docs/cost-tier-telemetry.md).
import type { Schema } from '../api/index.ts';

/** The raw `worker.operation` payload as typed by the generated /v0 spec. */
export type WorkerOperationPayload = Schema<'WorkerOperationEventPayload'>;

/** Placeholder scope key when the supervisor omits the agent attribution. */
export const UNKNOWN_AGENT = '(unattributed)';
/** Placeholder scope key when an operation is not bound to a work bead. */
export const NO_BEAD = '(no bead)';
/** Placeholder model key when the supervisor omits the model attribution. */
export const UNKNOWN_MODEL = '(unknown model)';

/**
 * One normalised LLM/worker operation, derived from a `worker.operation` SSE
 * envelope. Identity and attribution fall back to placeholders so every event
 * lands in exactly one agent bucket and one bead bucket. Token/cost fields are
 * `undefined` when the supervisor did not measure them — distinct from a
 * measured zero (see {@link TokenTotals.measuredOps}).
 */
export interface WorkerOperation {
  /** Monotonic supervisor sequence number (also the de-duplication key). */
  seq: number;
  /** RFC 3339 timestamp (envelope `ts`, falling back to `finished_at`). */
  ts: string;
  /** City the operation is tagged to ("" for supervisor-global). */
  city: string;
  /** Agent attribution: `agent_name` → `session_name` → {@link UNKNOWN_AGENT}. */
  agent: string;
  /** Work bead the operation acted on, or {@link NO_BEAD}. */
  bead: string;
  /** Model identifier, or {@link UNKNOWN_MODEL} when unattributed. */
  model: string;
  /** Provider identifier (e.g. "claude"), or "" when absent. */
  provider: string;
  /** Operation name (free-form, e.g. "session.submit"). */
  operation: string;
  /** Raw result string from the supervisor. */
  result: string;
  /** Whether the operation succeeded (derived; see `deriveOk`). */
  ok: boolean;
  /** Operation wall-clock duration in milliseconds (0 when unreported). */
  durationMs: number;
  /** Stable operation id, for tooltips / future per-op dedup. */
  opId: string;
  /** Non-cached input tokens, when measured. */
  promptTokens?: number;
  /** Output tokens, when measured. */
  completionTokens?: number;
  /** Input tokens written to the prompt cache, when measured. */
  cacheCreationTokens?: number;
  /** Cached input tokens read, when measured. */
  cacheReadTokens?: number;
  /** Estimated invocation cost in USD, when measured. */
  costUsd?: number;
  /** SSE `id:` value (reconnect cursor), when present. */
  cursor?: string;
}

/**
 * Accumulated token counts for a scope. `measuredOps` counts the operations that
 * reported *any* token field, so the UI can tell "0 because nothing measured it"
 * (`measuredOps === 0` → render "—") apart from "genuinely zero tokens".
 */
export interface TokenTotals {
  promptIn: number;
  completionOut: number;
  cacheCreation: number;
  cacheRead: number;
  /** Operations that contributed at least one measured token field. */
  measuredOps: number;
}

/** A zeroed {@link TokenTotals}. */
export function emptyTokenTotals(): TokenTotals {
  return { promptIn: 0, completionOut: 0, cacheCreation: 0, cacheRead: 0, measuredOps: 0 };
}

/**
 * Per-model usage within a scope — the closest proxy the /v0 contract gives us
 * for "tier", since the model is what a tier decision selects. One per distinct
 * model seen under an agent or bead.
 */
export interface ModelRollup {
  model: string;
  /** Providers observed serving this model (usually one), sorted. */
  providers: string[];
  operations: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  tokens: TokenTotals;
  /** Summed cost in USD when any op measured it, else null. */
  costUsd: number | null;
  /** Operations that reported a cost estimate. */
  costMeasuredOps: number;
  /** Most recent envelope timestamp seen for this model. */
  lastTs: string;
  /** Most recent supervisor seq seen for this model. */
  lastSeq: number;
}

/**
 * A rollup for one scope key — an agent or a bead. Aggregate counters plus a
 * per-model breakdown. `key` is the agent name or bead id.
 */
export interface ScopeRollup {
  key: string;
  operations: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  tokens: TokenTotals;
  costUsd: number | null;
  costMeasuredOps: number;
  /** Per-model usage, sorted by operation count (desc), then model name. */
  models: ModelRollup[];
  lastTs: string;
  lastSeq: number;
}

/** Grand totals across every tracked operation in the session. */
export interface TelemetryTotals {
  operations: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  tokens: TokenTotals;
  costUsd: number | null;
  costMeasuredOps: number;
  /** Distinct agents tracked. */
  agents: number;
  /** Distinct beads tracked. */
  beads: number;
}

/** Lifecycle state of the durable telemetry SSE subscription. */
export type TelemetryStreamState = 'connecting' | 'open' | 'reconnecting' | 'stopped';

/** Status of the durable telemetry SSE subscription, surfaced in the UI. */
export interface TelemetryStreamStatus {
  state: TelemetryStreamState;
  /** Human-readable detail (e.g. "retrying in 1200ms (attempt 3)"). */
  detail: string;
  /** Consecutive failed connect attempts; 0 while open. */
  attempt: number;
}

/** The full observable state the telemetry panes render. */
export interface TelemetryState {
  /** Per-agent rollups, most-recently-active first. */
  agents: ScopeRollup[];
  /** Per-bead rollups, most-recently-active first. */
  beads: ScopeRollup[];
  /** Grand totals across all tracked operations. */
  totals: TelemetryTotals;
  /** SSE subscription status, or null before it starts. */
  stream: TelemetryStreamStatus | null;
  /** True once scope eviction has dropped at least one cold agent/bead. */
  evicted: boolean;
  /**
   * Whether *any* token/cost field has ever been measured. While false, the UI
   * shows the "awaiting upstream instrumentation" affordance.
   */
  anyCostMeasured: boolean;
}
