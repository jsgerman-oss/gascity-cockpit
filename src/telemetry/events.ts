// Durable supervisor subscription + pure parser for the telemetry feed.
//
// The live status feature already consumes `/v0/events/stream`, but its
// `parseFleetEvent` projects the envelope `payload` away — and the per-feature
// merge guardrails (docs/contributing-features.md) say a feature never edits
// another's module. So telemetry runs its own subscription over the same shared
// primitives (`openSSE`, `backoffDelay`), exactly as `session-stream` opens its
// own SSE: independent stream consumers are the established pattern. It parses
// only `worker.operation` envelopes — the sole /v0 source of per-(agent, bead,
// model) cost telemetry — and ignores everything else client-side.
import {
  backoffDelay,
  Emitter,
  normalizeBaseUrl,
  type Logger,
} from '../discovery/index.ts';
import { openSSE, type OpenSSEOptions, type SSEMessage } from '../api/index.ts';
import {
  NO_BEAD,
  UNKNOWN_AGENT,
  UNKNOWN_MODEL,
  type TelemetryStreamStatus,
  type WorkerOperation,
} from './types.ts';

/** The SSE envelope type that carries worker telemetry. */
export const WORKER_OPERATION_TYPE = 'worker.operation';

/** Read a finite non-negative number, or undefined. Negatives/NaN are dropped. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Read a non-empty trimmed string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Decide whether an operation succeeded. The /v0 `result` is a free-form string
 * (no enum), so we treat the presence of an `error`, or a failure-ish `result`,
 * as failure; anything else is success. Kept pure so the heuristic is tested.
 */
export function deriveOk(result: string, error: string | undefined): boolean {
  if (error && error.trim()) return false;
  return !/\b(fail|failed|failure|error|errored|timeout|timed[_ -]?out|reject|denied|cancel)/i.test(
    result,
  );
}

/**
 * Parse one SSE message into a {@link WorkerOperation}, or null when it is not a
 * usable `worker.operation` envelope (heartbeat, other event type, missing
 * payload, or unparseable). Pure and network-free — the seam the tests exercise.
 *
 * Token and cost fields are included only when the supervisor actually reported
 * them; today they are "always absent" per the spec, so the parser yields them
 * as `undefined` and the store treats that as "not measured".
 */
export function parseWorkerOperation(msg: SSEMessage): WorkerOperation | null {
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

  const env = parsed as Record<string, unknown>;
  if (env.type !== WORKER_OPERATION_TYPE) return null;
  if (typeof env.seq !== 'number') return null;
  if (typeof env.payload !== 'object' || env.payload === null) return null;

  const p = env.payload as Record<string, unknown>;

  const result = nonEmptyString(p.result) ?? '';
  const error = nonEmptyString(p.error);
  const ts = nonEmptyString(env.ts) ?? nonEmptyString(p.finished_at) ?? '';

  const op: WorkerOperation = {
    seq: env.seq,
    ts,
    city: nonEmptyString(env.city) ?? '',
    agent: nonEmptyString(p.agent_name) ?? nonEmptyString(p.session_name) ?? UNKNOWN_AGENT,
    bead: nonEmptyString(p.bead_id) ?? NO_BEAD,
    model: nonEmptyString(p.model) ?? UNKNOWN_MODEL,
    provider: nonEmptyString(p.provider) ?? '',
    operation: nonEmptyString(p.operation) ?? '(operation)',
    result,
    ok: deriveOk(result, error),
    durationMs: finiteNumber(p.duration_ms) ?? 0,
    opId: nonEmptyString(p.op_id) ?? '',
  };

  const promptTokens = finiteNumber(p.prompt_tokens);
  if (promptTokens !== undefined) op.promptTokens = promptTokens;
  const completionTokens = finiteNumber(p.completion_tokens);
  if (completionTokens !== undefined) op.completionTokens = completionTokens;
  const cacheCreationTokens = finiteNumber(p.cache_creation_tokens);
  if (cacheCreationTokens !== undefined) op.cacheCreationTokens = cacheCreationTokens;
  const cacheReadTokens = finiteNumber(p.cache_read_tokens);
  if (cacheReadTokens !== undefined) op.cacheReadTokens = cacheReadTokens;
  const costUsd = finiteNumber(p.cost_usd_estimate);
  if (costUsd !== undefined) op.costUsd = costUsd;
  if (msg.id) op.cursor = msg.id;

  return op;
}

export interface TelemetryStreamOptions {
  /** Base delay (ms) for exponential reconnect backoff. */
  baseDelayMs: number;
  /** Ceiling (ms) for exponential reconnect backoff. */
  maxDelayMs: number;
  /** ±fraction of jitter applied to each backoff delay. */
  jitterFactor: number;
}

export const DEFAULT_TELEMETRY_STREAM_OPTIONS: TelemetryStreamOptions = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitterFactor: 0.2,
};

/** Opens one SSE connection. Defaults to {@link openSSE}; injectable for tests. */
export type OpenStream = (url: string, options: OpenSSEOptions) => AsyncIterable<SSEMessage>;

/** Sleeps `ms`, rejecting if `signal` aborts. Injectable for tests. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface TelemetryStreamDeps {
  openStream?: OpenStream;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  sleep?: Sleep;
  random?: () => number;
  log?: Logger;
  options?: Partial<TelemetryStreamOptions>;
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
 * A durable subscription to `GET /v0/events/stream` that yields parsed
 * {@link WorkerOperation}s. Loops {@link openSSE}, threads `Last-Event-ID` so no
 * events are missed across reconnects, and backs off on failure. Every side
 * effect is injected so the reconnect state machine is unit-testable with no
 * sockets and no real timers — mirroring `SupervisorEventStream`.
 */
export class TelemetryStream {
  private readonly base: string;
  private readonly openStream: OpenStream;
  private readonly fetchImpl?: typeof fetch;
  private readonly headers?: Record<string, string>;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly log: Logger;
  private readonly options: TelemetryStreamOptions;

  private readonly eventEmitter = new Emitter<WorkerOperation>();
  private readonly statusEmitter = new Emitter<TelemetryStreamStatus>();

  private controller: AbortController | null = null;
  /** Bumped on start/stop to invalidate an in-flight run loop. */
  private generation = 0;
  /** SSE cursor threaded into reconnects so no events are missed. */
  private lastEventId: string | undefined;
  private status: TelemetryStreamStatus = { state: 'stopped', detail: 'not started', attempt: 0 };

  constructor(baseUrl: string, deps: TelemetryStreamDeps = {}) {
    this.base = normalizeBaseUrl(baseUrl);
    this.openStream = deps.openStream ?? ((url, opts) => openSSE(url, opts));
    this.fetchImpl = deps.fetch;
    this.headers = deps.headers;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (() => {});
    this.options = { ...DEFAULT_TELEMETRY_STREAM_OPTIONS, ...deps.options };
  }

  /** Subscribe to parsed worker operations. */
  readonly onEvent = this.eventEmitter.event;
  /** Subscribe to subscription lifecycle changes. */
  readonly onStatus = this.statusEmitter.event;

  /** Current subscription status snapshot. */
  get currentStatus(): TelemetryStreamStatus {
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

  private setStatus(status: TelemetryStreamStatus): void {
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
          const op = parseWorkerOperation(msg);
          if (op) this.eventEmitter.fire(op);
        }
        if (!this.alive(generation, signal)) return;
        this.log('info', 'telemetry stream closed by server; reconnecting');
      } catch (err) {
        if (!this.alive(generation, signal)) return;
        this.log('warn', 'telemetry stream error', { error: errorMessage(err) });
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
