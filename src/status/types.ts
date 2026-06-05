// Domain model for the live status panes (cockpit-1ll.6).
//
// The status feature is a Seam-1 layer (PRD Testing Decisions): a
// provider-agnostic store fed by the typed /v0 client and the supervisor SSE
// event stream. Nothing here imports `vscode`; the editor glue (tree views)
// adapts this model in `views.ts`.
import type { Schema, SupervisorHealth } from '../api/index.ts';

export type { SupervisorHealth };

/** A registered city as reported by `GET /v0/cities`. */
export type CityInfo = Schema<'CityInfo'>;

/** An agent (worker) as reported by `GET /v0/city/{cityName}/agents`. */
export type AgentResponse = Schema<'AgentResponse'>;

/** A session as reported by `GET /v0/city/{cityName}/sessions`. */
export type SessionResponse = Schema<'SessionResponse'>;

/**
 * One supervisor-tagged event, normalised from the SSE `/v0/events/stream`
 * envelope into the fields the feed renders. `cursor` is the SSE `id:` used to
 * resume the stream after a reconnect.
 */
export interface FleetEvent {
  /** Monotonic supervisor sequence number. */
  seq: number;
  /** Dot-namespaced event type, e.g. `session.updated`, `city.suspended`. */
  type: string;
  /** RFC 3339 timestamp string from the supervisor. */
  ts: string;
  /** Who/what emitted the event (agent id, "controller", …). */
  actor: string;
  /** City the event is tagged to ("" for supervisor-global events). */
  city: string;
  /** Optional subject (e.g. the session/bead id the event concerns). */
  subject?: string;
  /** Optional human-readable one-liner. */
  message?: string;
  /** SSE `id:` value, used as the reconnect cursor (`Last-Event-ID`). */
  cursor?: string;
}

/** Lifecycle state of the durable SSE subscription. */
export type EventStreamState = 'connecting' | 'open' | 'reconnecting' | 'stopped';

/** Status of the durable SSE subscription, surfaced in the UI. */
export interface EventStreamStatus {
  state: EventStreamState;
  /** Human-readable detail (e.g. "retrying in 1200ms (attempt 3)"). */
  detail: string;
  /** Consecutive failed connect attempts; 0 while open. */
  attempt: number;
}

/**
 * A point-in-time snapshot of the fleet, produced by `fetchFleetSnapshot` and
 * applied to the store. `agentsByCity`/`sessionsByCity` are keyed by city name.
 */
export interface FleetSnapshot {
  health: SupervisorHealth | null;
  cities: CityInfo[];
  agentsByCity: Record<string, AgentResponse[]>;
  sessionsByCity: Record<string, SessionResponse[]>;
  /** Non-fatal per-call failures (a city that failed to enumerate, etc.). */
  partialErrors: string[];
}

/** The full observable state the panes render. */
export interface FleetStatusState {
  health: SupervisorHealth | null;
  cities: CityInfo[];
  agentsByCity: Record<string, AgentResponse[]>;
  sessionsByCity: Record<string, SessionResponse[]>;
  /** Recent events, newest first, bounded by {@link EVENTS_CAP}. */
  events: FleetEvent[];
  /** Non-fatal errors from the most recent snapshot. */
  partialErrors: string[];
  /** SSE subscription status, or null before it starts. */
  eventStream: EventStreamStatus | null;
  /** A fatal-ish error (e.g. snapshot failed / API unavailable), or null. */
  lastError: string | null;
}
