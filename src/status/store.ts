// FleetStatusStore — the observable model behind the live status panes.
//
// A plain, `vscode`-free state container (Seam 1). Snapshots from the typed
// client and events from the SSE stream are pushed in; the tree views subscribe
// to `onDidChange` and re-render from `state`. All mutation goes through methods
// so the single change signal stays the only thing the glue must wire up.
import { Emitter } from '../discovery/index.ts';
import type {
  EventStreamStatus,
  FleetEvent,
  FleetSnapshot,
  FleetStatusState,
} from './types.ts';

/** Maximum events retained in the feed ring buffer (newest kept). */
export const EVENTS_CAP = 250;

function emptyState(): FleetStatusState {
  return {
    health: null,
    cities: [],
    agentsByCity: {},
    sessionsByCity: {},
    events: [],
    partialErrors: [],
    eventStream: null,
    lastError: null,
  };
}

export class FleetStatusStore {
  private _state: FleetStatusState = emptyState();
  private readonly emitter = new Emitter<FleetStatusState>();

  /** The maximum number of events retained, configurable for tests. */
  constructor(private readonly eventsCap: number = EVENTS_CAP) {}

  /** Subscribe to any state change. Fires after every mutation. */
  readonly onDidChange = this.emitter.event;

  /** Current immutable-by-convention state. Treat as read-only. */
  get state(): FleetStatusState {
    return this._state;
  }

  /**
   * Replace the snapshot-derived portion of the state (health, cities, agents,
   * sessions, partial errors) while preserving the live event feed and stream
   * status. Clears `lastError` — a successful snapshot means we're talking to
   * the API again.
   */
  applySnapshot(snapshot: FleetSnapshot): void {
    this._state = {
      ...this._state,
      health: snapshot.health,
      cities: snapshot.cities,
      agentsByCity: snapshot.agentsByCity,
      sessionsByCity: snapshot.sessionsByCity,
      partialErrors: snapshot.partialErrors,
      lastError: null,
    };
    this.fire();
  }

  /** Append one event to the feed (newest first), bounded by the cap. */
  addEvent(event: FleetEvent): void {
    const events = [event, ...this._state.events];
    if (events.length > this.eventsCap) events.length = this.eventsCap;
    this._state = { ...this._state, events };
    this.fire();
  }

  /** Replace the SSE subscription status. */
  setEventStreamStatus(status: EventStreamStatus): void {
    this._state = { ...this._state, eventStream: status };
    this.fire();
  }

  /** Record a fatal-ish error (snapshot failed, API unavailable, …). */
  setError(message: string): void {
    this._state = { ...this._state, lastError: message };
    this.fire();
  }

  /**
   * Reset the snapshot-derived state and error (e.g. on disconnect), keeping
   * the event feed so the operator can still read recent history.
   */
  clearSnapshot(reason: string | null = null): void {
    this._state = {
      ...this._state,
      health: null,
      cities: [],
      agentsByCity: {},
      sessionsByCity: {},
      partialErrors: [],
      lastError: reason,
    };
    this.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private fire(): void {
    this.emitter.fire(this._state);
  }
}
