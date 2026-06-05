// LiveStatus — orchestrates the typed client and the SSE event stream into the
// store. This is the seam the editor glue drives: `connect(endpoint)` when the
// ConnectionManager reports a healthy supervisor, `disconnect()` when it goes
// away. On connect it takes a full snapshot and subscribes to events; each
// status-affecting event schedules a debounced re-snapshot, so the panes stay
// live without per-event incremental bookkeeping. All collaborators (client,
// stream) and timers are injected, keeping it `vscode`-free and unit-testable.
import type { Disposable, Logger } from '../discovery/index.ts';
import type { CockpitClient } from '../api/index.ts';
import { affectsStatusPanes, type SupervisorEventStream } from './events.ts';
import { fetchFleetSnapshot } from './snapshot.ts';
import type { FleetStatusStore } from './store.ts';
import type { FleetEvent } from './types.ts';

/** Where to reach a supervisor: base URL plus an optional bearer token. */
export interface StatusEndpoint {
  baseUrl: string;
  token?: string;
}

export interface LiveStatusOptions {
  /** Debounce window (ms) coalescing event-triggered snapshot refreshes. */
  refreshDebounceMs: number;
}

export const DEFAULT_LIVE_STATUS_OPTIONS: LiveStatusOptions = {
  refreshDebounceMs: 400,
};

export interface LiveStatusDeps {
  store: FleetStatusStore;
  /** Build a typed client for an endpoint (injected so tests pass a mock). */
  createClient: (endpoint: StatusEndpoint) => CockpitClient;
  /** Build a durable event stream for an endpoint (injected for tests). */
  createStream: (endpoint: StatusEndpoint) => SupervisorEventStream;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: Logger;
  options?: Partial<LiveStatusOptions>;
}

export class LiveStatus {
  private readonly store: FleetStatusStore;
  private readonly createClient: (endpoint: StatusEndpoint) => CockpitClient;
  private readonly createStream: (endpoint: StatusEndpoint) => SupervisorEventStream;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: Logger;
  private readonly options: LiveStatusOptions;

  private client: CockpitClient | null = null;
  private stream: SupervisorEventStream | null = null;
  private subscriptions: Disposable[] = [];
  private refreshTimer: unknown = null;
  private snapshotAbort: AbortController | null = null;

  /** Bumped on connect/disconnect to invalidate in-flight work. */
  private generation = 0;
  /** Bumped per refresh so only the newest snapshot is applied. */
  private latestRefresh = 0;

  constructor(deps: LiveStatusDeps) {
    this.store = deps.store;
    this.createClient = deps.createClient;
    this.createStream = deps.createStream;
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = deps.log ?? (() => {});
    this.options = { ...DEFAULT_LIVE_STATUS_OPTIONS, ...deps.options };
  }

  /**
   * Point the live status at a supervisor: tear down any prior connection,
   * build a client + event stream, take an immediate snapshot, and subscribe to
   * the event feed.
   */
  connect(endpoint: StatusEndpoint): void {
    this.disconnect();
    this.generation += 1;
    const generation = this.generation;

    // Show "connecting…" until the first snapshot (or error) lands, rather than
    // a premature "no cities" (cockpit-1ll.16). Cleared by applySnapshot/setError.
    this.store.setLoading(true);
    this.client = this.createClient(endpoint);
    const stream = this.createStream(endpoint);
    this.stream = stream;
    this.subscriptions.push(stream.onEvent((event) => this.onEvent(event)));
    this.subscriptions.push(stream.onStatus((status) => this.store.setEventStreamStatus(status)));
    stream.start();

    void this.refresh(generation);
  }

  /** Tear down the connection, keeping the store's event history. */
  disconnect(): void {
    this.generation += 1;
    // A connection that never produced a snapshot must not leave the tree stuck
    // on "connecting…" once it goes away.
    this.store.setLoading(false);
    this.clearRefreshTimer();
    if (this.snapshotAbort) {
      this.snapshotAbort.abort();
      this.snapshotAbort = null;
    }
    if (this.stream) {
      this.stream.dispose();
      this.stream = null;
    }
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions = [];
    this.client = null;
  }

  /** Force an immediate snapshot refresh (e.g. the "Refresh" command). */
  refreshNow(): void {
    if (!this.client) return;
    this.clearRefreshTimer();
    void this.refresh(this.generation);
  }

  dispose(): void {
    this.disconnect();
  }

  private onEvent(event: FleetEvent): void {
    this.store.addEvent(event);
    if (affectsStatusPanes(event.type)) {
      this.scheduleRefresh(this.options.refreshDebounceMs);
    }
  }

  private scheduleRefresh(delayMs: number): void {
    if (!this.client) return;
    this.clearRefreshTimer();
    const generation = this.generation;
    this.refreshTimer = this.setTimer(() => {
      this.refreshTimer = null;
      void this.refresh(generation);
    }, delayMs);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      this.clearTimer(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refresh(generation: number): Promise<void> {
    const client = this.client;
    if (!client || generation !== this.generation) return;

    // Supersede any prior in-flight snapshot.
    if (this.snapshotAbort) this.snapshotAbort.abort();
    const abort = new AbortController();
    this.snapshotAbort = abort;
    const refreshId = ++this.latestRefresh;

    try {
      const snapshot = await fetchFleetSnapshot(client, { signal: abort.signal });
      if (generation !== this.generation || refreshId !== this.latestRefresh) return;
      this.store.applySnapshot(snapshot);
    } catch (err) {
      if (generation !== this.generation || refreshId !== this.latestRefresh) return;
      this.store.setError(`snapshot failed: ${errorMessage(err)}`);
      this.log('warn', 'live status snapshot failed', { error: errorMessage(err) });
    } finally {
      if (this.snapshotAbort === abort) this.snapshotAbort = null;
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
