// Durable supervisor event subscription for the live feed.
//
// `openSSE` (api/sse) is a single connection that ends on server close or abort;
// the PRD leaves reconnection to callers. `SupervisorEventStream` is that
// caller: it loops `openSSE` over `/v0/events/stream`, threads `Last-Event-ID`
// so no events are missed across reconnects, and backs off on failure — reusing
// the same `backoffDelay` the health ConnectionManager uses. Every side effect
// (the stream opener, sleep, randomness, time) is injected so the reconnect
// state machine is unit-testable with no sockets and no real timers.
import {
  backoffDelay,
  Emitter,
  normalizeBaseUrl,
  type Logger,
} from '../discovery/index.ts';
import { openSSE, type OpenSSEOptions, type SSEMessage } from '../api/index.ts';
import type { EventStreamStatus, FleetEvent } from './types.ts';

/**
 * Parse one SSE message into a {@link FleetEvent}, or null when it is not a
 * fleet event (heartbeat keep-alive, comment, or an unparseable / unexpected
 * payload). Pure and network-free.
 */
export function parseFleetEvent(msg: SSEMessage): FleetEvent | null {
  if (msg.event === 'heartbeat') return null;
  const raw = msg.data.trim();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const o = parsed as Record<string, unknown>;
  if (typeof o.type !== 'string' || typeof o.seq !== 'number') return null;

  return {
    seq: o.seq,
    type: o.type,
    ts: typeof o.ts === 'string' ? o.ts : '',
    actor: typeof o.actor === 'string' ? o.actor : '',
    city: typeof o.city === 'string' ? o.city : '',
    ...(typeof o.subject === 'string' && o.subject ? { subject: o.subject } : {}),
    ...(typeof o.message === 'string' && o.message ? { message: o.message } : {}),
    ...(msg.id ? { cursor: msg.id } : {}),
  };
}

/**
 * Whether an event type can change the health/cities/agents/sessions panes and
 * therefore warrants a snapshot refresh. Mail traffic is chatty and has no
 * representation in these panes, so it is ignored; everything else (session /
 * agent / city / controller / bead / order / convoy / request lifecycle) can.
 */
export function affectsStatusPanes(type: string): boolean {
  return !type.startsWith('mail.');
}

export interface EventStreamOptions {
  /** Base delay (ms) for exponential reconnect backoff. */
  baseDelayMs: number;
  /** Ceiling (ms) for exponential reconnect backoff. */
  maxDelayMs: number;
  /** ±fraction of jitter applied to each backoff delay. */
  jitterFactor: number;
}

export const DEFAULT_EVENT_STREAM_OPTIONS: EventStreamOptions = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitterFactor: 0.2,
};

/** Opens one SSE connection. Defaults to {@link openSSE}; injectable for tests. */
export type OpenStream = (url: string, options: OpenSSEOptions) => AsyncIterable<SSEMessage>;

/** Sleeps `ms`, rejecting if `signal` aborts. Injectable for tests. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface EventStreamDeps {
  openStream?: OpenStream;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  sleep?: Sleep;
  random?: () => number;
  log?: Logger;
  options?: Partial<EventStreamOptions>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * A durable subscription to `GET /v0/events/stream`. Call {@link start} to begin
 * streaming and {@link stop} to abort. Events arrive via {@link onEvent} and the
 * connection lifecycle via {@link onStatus}.
 */
export class SupervisorEventStream {
  private readonly base: string;
  private readonly openStream: OpenStream;
  private readonly fetchImpl?: typeof fetch;
  private readonly headers?: Record<string, string>;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly log: Logger;
  private readonly options: EventStreamOptions;

  private readonly eventEmitter = new Emitter<FleetEvent>();
  private readonly statusEmitter = new Emitter<EventStreamStatus>();

  private controller: AbortController | null = null;
  /** Bumped on start/stop to invalidate an in-flight run loop. */
  private generation = 0;
  /** SSE cursor threaded into reconnects so no events are missed. */
  private lastEventId: string | undefined;
  private status: EventStreamStatus = { state: 'stopped', detail: 'not started', attempt: 0 };

  constructor(baseUrl: string, deps: EventStreamDeps = {}) {
    this.base = normalizeBaseUrl(baseUrl);
    this.openStream = deps.openStream ?? ((url, opts) => openSSE(url, opts));
    this.fetchImpl = deps.fetch;
    this.headers = deps.headers;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (() => {});
    this.options = { ...DEFAULT_EVENT_STREAM_OPTIONS, ...deps.options };
  }

  /** Subscribe to parsed fleet events. */
  readonly onEvent = this.eventEmitter.event;
  /** Subscribe to subscription lifecycle changes. */
  readonly onStatus = this.statusEmitter.event;

  /** Current subscription status snapshot. */
  get currentStatus(): EventStreamStatus {
    return this.status;
  }

  /** Begin streaming. Idempotent while already running. */
  start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.generation += 1;
    void this.run(this.generation, controller.signal);
  }

  /** Abort the stream and any pending reconnect. */
  stop(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    this.generation += 1;
    this.setStatus({ state: 'stopped', detail: 'stopped', attempt: 0 });
  }

  dispose(): void {
    this.stop();
    this.eventEmitter.dispose();
    this.statusEmitter.dispose();
  }

  private alive(generation: number, signal: AbortSignal): boolean {
    return generation === this.generation && !signal.aborted;
  }

  private setStatus(status: EventStreamStatus): void {
    this.status = status;
    this.statusEmitter.fire(status);
  }

  private async run(generation: number, signal: AbortSignal): Promise<void> {
    const url = `${this.base}/v0/events/stream`;
    let attempt = 0;

    while (this.alive(generation, signal)) {
      this.setStatus(
        attempt === 0
          ? { state: 'connecting', detail: `connecting to ${url}`, attempt: 0 }
          : { state: 'reconnecting', detail: `reconnecting (attempt ${attempt})`, attempt },
      );

      try {
        const opts: OpenSSEOptions = {
          signal,
          ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
          ...(this.headers ? { headers: this.headers } : {}),
          ...(this.lastEventId ? { lastEventId: this.lastEventId } : {}),
        };
        let opened = false;
        for await (const msg of this.openStream(url, opts)) {
          if (!this.alive(generation, signal)) return;
          if (!opened) {
            opened = true;
            attempt = 0;
            this.setStatus({ state: 'open', detail: 'streaming', attempt: 0 });
          }
          if (msg.id) this.lastEventId = msg.id;
          const event = parseFleetEvent(msg);
          if (event) this.eventEmitter.fire(event);
        }
        if (!this.alive(generation, signal)) return;
        this.log('info', 'event stream closed by server; reconnecting');
      } catch (err) {
        if (!this.alive(generation, signal)) return;
        this.log('warn', 'event stream error', { error: errorMessage(err) });
      }

      attempt += 1;
      const delay = backoffDelay(attempt, this.options, this.random);
      this.setStatus({
        state: 'reconnecting',
        detail: `retrying in ${delay}ms (attempt ${attempt})`,
        attempt,
      });
      try {
        await this.sleep(delay, signal);
      } catch {
        return; // aborted during backoff
      }
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
