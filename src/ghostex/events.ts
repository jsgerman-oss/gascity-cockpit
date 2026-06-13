/**
 * The gxserver real-time feed: subscribe to the `/api/events` WebSocket, parse
 * the frames into typed {@link GhostexEvent}s, and keep the connection alive with
 * exponential backoff + resubscribe-on-(re)connect. Mirrors the *intent* of the
 * SSE reader in `src/api/sse.ts` (a tolerant parser plus a caller-owned reconnect
 * loop), adapted to gxserver's WebSocket transport and presentation deltas.
 *
 * `vscode`-free and socket-free under test: the WebSocket is created through an
 * injected factory, so a fake socket drives the whole lifecycle (open, message,
 * error, close, reconnect) deterministically with a fake clock.
 *
 * Backoff defaults align with the supervisor connection core
 * (`DEFAULT_CONNECTION_OPTIONS`): base 500ms, ceiling 15s, ±20% jitter.
 */

import { isRecord, parsePresentationSession, parsePresentationSnapshot } from './parse.ts';
import {
  GXSERVER_PROTOCOL_VERSION,
  type GhostexPresentationSession,
  type GhostexPresentationSnapshot,
} from './types.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;

/**
 * The minimal WebSocket surface this module needs — a structural subset of both
 * the browser `WebSocket` and the `ws` package. Modelling it locally keeps the
 * core free of DOM lib types and the `ws` dependency, and makes faking trivial.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((this: void) => void) | null;
  onmessage: ((this: void, event: { data: unknown }) => void) | null;
  onerror: ((this: void, event: unknown) => void) | null;
  onclose: ((this: void, event: { code?: number; reason?: string }) => void) | null;
}

/** Creates a socket for a URL (with the protocol header conveyed via query/subprotocol). */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** A typed Ghostex real-time event, narrowed from the raw `/api/events` frames. */
export type GhostexEvent =
  | { readonly type: 'eventStreamReady'; readonly serverId: string }
  | { readonly type: 'serverStarted'; readonly serverId: string }
  | { readonly type: 'serverStopping'; readonly serverId: string }
  | {
      readonly type: 'presentationSnapshot';
      readonly revision: number;
      readonly snapshot: GhostexPresentationSnapshot;
    }
  | {
      readonly type: 'presentationDelta';
      readonly revision: number;
      readonly delta: GhostexDelta;
    };

/** A narrowed presentation delta — only the variants the Cockpit acts on. */
export type GhostexDelta =
  | { readonly kind: 'sessionUpserted'; readonly session: GhostexPresentationSession }
  | { readonly kind: 'sessionRemoved'; readonly projectId: string; readonly sessionId: string }
  | { readonly kind: 'projectRemoved'; readonly projectId: string }
  | { readonly kind: 'other'; readonly deltaType: string };

const SESSION_UPSERT_TYPES = new Set([
  'sessionAdded',
  'sessionUpdated',
  'sessionMoved',
  'sessionTitleChanged',
  'sessionActivityChanged',
  'sessionLifecycleChanged',
  'sessionSurfaceChanged',
  'sessionPresentationChanged',
]);

/**
 * Parse one raw `/api/events` frame payload (already JSON-parsed) into a typed
 * {@link GhostexEvent}, or `null` when it is a frame the Cockpit ignores
 * (`apiRequestHandled`, `rendererCommand`, unknown types, malformed bodies).
 */
export function parseGhostexEvent(raw: unknown): GhostexEvent | null {
  if (!isRecord(raw)) return null;
  const type = raw['type'];
  if (typeof type !== 'string') return null;

  switch (type) {
    case 'eventStreamReady':
    case 'serverStarted':
    case 'serverStopping':
      return { type, serverId: typeof raw['serverId'] === 'string' ? raw['serverId'] : '' };
    case 'presentationSnapshot':
      try {
        return {
          type: 'presentationSnapshot',
          revision: typeof raw['revision'] === 'number' ? raw['revision'] : 0,
          snapshot: parsePresentationSnapshot(raw['snapshot']),
        };
      } catch {
        return null;
      }
    case 'presentationDelta': {
      const delta = parseDelta(raw['delta']);
      if (!delta) return null;
      return {
        type: 'presentationDelta',
        revision: typeof raw['revision'] === 'number' ? raw['revision'] : 0,
        delta,
      };
    }
    default:
      return null;
  }
}

function parseDelta(raw: unknown): GhostexDelta | null {
  if (!isRecord(raw)) return null;
  const deltaType = raw['type'];
  if (typeof deltaType !== 'string') return null;

  if (SESSION_UPSERT_TYPES.has(deltaType)) {
    try {
      return { kind: 'sessionUpserted', session: parsePresentationSession(raw['session']) };
    } catch {
      return null;
    }
  }
  if (deltaType === 'sessionRemoved') {
    const projectId = raw['projectId'];
    const sessionId = raw['sessionId'];
    if (typeof projectId === 'string' && typeof sessionId === 'string') {
      return { kind: 'sessionRemoved', projectId, sessionId };
    }
    return null;
  }
  if (deltaType === 'projectRemoved') {
    const projectId = raw['projectId'];
    if (typeof projectId === 'string') return { kind: 'projectRemoved', projectId };
    return null;
  }
  return { kind: 'other', deltaType };
}

export interface GhostexEventStreamOptions {
  /** Base URL of the gxserver daemon, e.g. `http://127.0.0.1:58744`. */
  baseUrl: string;
  /** Bearer token; conveyed via the connection URL query (WebSocket has no auth header). */
  token?: string | null;
  /** Creates the underlying socket. Required (injected) so tests need no real WS. */
  createWebSocket: WebSocketFactory;
  /** Receives each parsed, typed event. */
  onEvent: (event: GhostexEvent) => void;
  /** Base reconnect delay (ms). Default 500. */
  baseDelayMs?: number;
  /** Reconnect delay ceiling (ms). Default 15000. */
  maxDelayMs?: number;
  /** ±fraction of jitter on each backoff delay. Default 0.2. */
  jitterFactor?: number;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  log?: Logger;
}

/** Connection state of the stream, surfaced for diagnostics/UI. */
export type GhostexStreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Build the `ws(s)://…/api/events` URL from an `http(s)` base, threading the
 * protocol version (and token, when set) as query params — a WebSocket handshake
 * cannot carry the `x-gxserver-protocol-version`/`Authorization` headers a
 * browser-style client would, so gxserver also accepts them on the query string.
 */
export function eventsUrl(baseUrl: string, token?: string | null): string {
  const ws = baseUrl.replace(/^http(s?):\/\//, 'ws$1://').replace(/\/+$/, '');
  const url = new URL(`${ws}/api/events`);
  url.searchParams.set('protocolVersion', String(GXSERVER_PROTOCOL_VERSION));
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/**
 * A self-healing subscription to the gxserver `/api/events` feed. `start()`
 * opens the socket and (re)subscribes to presentation on every open; a drop
 * schedules a backed-off reconnect that re-subscribes, so a gxserver restart is
 * transparently recovered. `stop()` tears everything down.
 */
export class GhostexEventStream {
  private readonly opts: Required<
    Omit<GhostexEventStreamOptions, 'token' | 'log'>
  > & { token: string | null; log: Logger };

  private socket: WebSocketLike | null = null;
  private state: GhostexStreamState = 'idle';
  private running = false;
  private attempt = 0;
  /** Bumped on start/stop to invalidate in-flight timers/socket callbacks. */
  private generation = 0;
  private timer: unknown = null;
  /** Highest snapshot/delta revision seen, sent on resubscribe to resume. */
  private lastRevision: number | null = null;

  constructor(options: GhostexEventStreamOptions) {
    this.opts = {
      baseUrl: options.baseUrl,
      token: options.token ?? null,
      createWebSocket: options.createWebSocket,
      onEvent: options.onEvent,
      baseDelayMs: options.baseDelayMs ?? 500,
      maxDelayMs: options.maxDelayMs ?? 15_000,
      jitterFactor: options.jitterFactor ?? 0.2,
      now: options.now ?? (() => Date.now()),
      setTimer: options.setTimer ?? ((cb, ms) => setTimeout(cb, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      random: options.random ?? Math.random,
      log: options.log ?? (() => {}),
    };
  }

  /** Current connection state (for diagnostics/UI). */
  get connectionState(): GhostexStreamState {
    return this.state;
  }

  /** Open the stream. Idempotent while already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.attempt = 0;
    this.open(this.generation);
  }

  /** Tear down the stream and cancel any pending reconnect. */
  stop(): void {
    if (!this.running && this.state === 'idle') return;
    this.running = false;
    this.generation += 1;
    this.clearTimer();
    this.closeSocket();
    this.state = 'closed';
  }

  dispose(): void {
    this.stop();
  }

  private open(generation: number): void {
    if (!this.alive(generation)) return;
    this.state = this.attempt === 0 ? 'connecting' : 'reconnecting';

    let socket: WebSocketLike;
    try {
      socket = this.opts.createWebSocket(eventsUrl(this.opts.baseUrl, this.opts.token));
    } catch (err) {
      this.opts.log('warn', 'ghostex events: socket construction failed', { error: String(err) });
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;

    socket.onopen = (): void => {
      if (!this.alive(generation)) return;
      this.attempt = 0;
      this.state = 'open';
      this.opts.log('info', 'ghostex events: connected', { baseUrl: this.opts.baseUrl });
      this.subscribe();
    };

    socket.onmessage = (event): void => {
      if (!this.alive(generation)) return;
      this.handleMessage(event.data);
    };

    socket.onerror = (event): void => {
      this.opts.log('warn', 'ghostex events: socket error', { error: stringifyError(event) });
      // A `close` normally follows an `error`; reconnect is scheduled there.
    };

    socket.onclose = (event): void => {
      if (!this.alive(generation)) return;
      this.socket = null;
      this.opts.log('info', 'ghostex events: closed', { code: event.code, reason: event.reason });
      this.scheduleReconnect(generation);
    };
  }

  /** (Re)subscribe to the presentation stream, resuming from the last revision. */
  private subscribe(): void {
    if (!this.socket) return;
    const message: Record<string, unknown> = {
      type: 'subscribePresentation',
      protocolVersion: GXSERVER_PROTOCOL_VERSION,
    };
    if (this.lastRevision !== null) message['lastRevision'] = this.lastRevision;
    try {
      this.socket.send(JSON.stringify(message));
    } catch (err) {
      this.opts.log('warn', 'ghostex events: subscribe send failed', { error: String(err) });
    }
  }

  private handleMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : bufferToString(data);
    if (text === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return; // ignore non-JSON frames (keep-alives, partials)
    }
    const event = parseGhostexEvent(raw);
    if (!event) return;
    if (event.type === 'presentationSnapshot' || event.type === 'presentationDelta') {
      this.lastRevision = event.revision;
    }
    this.opts.onEvent(event);
  }

  private scheduleReconnect(generation: number): void {
    if (!this.running || !this.alive(generation)) return;
    this.attempt += 1;
    this.state = 'reconnecting';
    const delay = backoffDelay(this.attempt, this.opts, this.opts.random);
    this.opts.log('warn', 'ghostex events: reconnecting', { attempt: this.attempt, delayMs: delay });
    this.clearTimer();
    this.timer = this.opts.setTimer(() => this.open(generation), delay);
  }

  private closeSocket(): void {
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      // Detach handlers first so the close we trigger doesn't schedule a reconnect.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Closing an already-closed socket is harmless.
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.opts.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private alive(generation: number): boolean {
    return this.running && generation === this.generation;
  }
}

/**
 * Exponential backoff with jitter (exported for direct testing). `attempt` is
 * 1-based; matches the supervisor `backoffDelay` shape so the two cores behave
 * identically.
 */
export function backoffDelay(
  attempt: number,
  opts: { baseDelayMs: number; maxDelayMs: number; jitterFactor: number },
  random: () => number,
): number {
  const exp = opts.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(opts.maxDelayMs, exp);
  const jitter = (random() * 2 - 1) * opts.jitterFactor;
  return Math.max(0, Math.round(capped * (1 + jitter)));
}

/** Best-effort coercion of a binary WS frame to text; `null` when not coercible. */
function bufferToString(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder('utf-8').decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(new Uint8Array(data));
  return null;
}

function stringifyError(event: unknown): string {
  if (event instanceof Error) return event.message;
  if (isRecord(event) && typeof event['message'] === 'string') return event['message'];
  return String(event);
}
