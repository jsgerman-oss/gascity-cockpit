import { describe, expect, it } from 'vitest';
import {
  deriveOk,
  parseWorkerOperation,
  TelemetryStream,
  WORKER_OPERATION_TYPE,
} from './events';
import { NO_BEAD, UNKNOWN_AGENT, UNKNOWN_MODEL } from './types';
import type { SSEMessage } from '../api/index';
import type { TelemetryStreamStatus, WorkerOperation } from './types';

const msg = (over: Partial<SSEMessage> = {}): SSEMessage => ({
  event: 'message',
  data: '',
  id: undefined,
  retry: undefined,
  ...over,
});

/** Build a `worker.operation` SSE envelope with an overridable payload. */
const envelope = (payload: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: WORKER_OPERATION_TYPE,
    seq: 1,
    ts: 't',
    actor: 'a',
    city: 'c',
    payload: {
      operation: 'session.submit',
      result: 'success',
      op_id: 'op-1',
      duration_ms: 1200,
      agent_name: 'gastown.nux',
      bead_id: 'bead-1',
      model: 'claude-opus-4-8',
      provider: 'claude',
      ...payload,
    },
    ...over,
  });

describe('deriveOk', () => {
  it('treats an error string as failure', () => {
    expect(deriveOk('success', 'boom')).toBe(false);
    expect(deriveOk('success', '   ')).toBe(true); // blank error ignored
  });

  it('reads failure-ish result strings as failure, others as success', () => {
    expect(deriveOk('failed', undefined)).toBe(false);
    expect(deriveOk('ERROR', undefined)).toBe(false);
    expect(deriveOk('timed_out', undefined)).toBe(false);
    expect(deriveOk('cancelled', undefined)).toBe(false);
    expect(deriveOk('success', undefined)).toBe(true);
    expect(deriveOk('', undefined)).toBe(true);
    expect(deriveOk('completed', undefined)).toBe(true);
  });
});

describe('parseWorkerOperation', () => {
  it('parses a worker.operation envelope, reading attribution from the payload', () => {
    const op = parseWorkerOperation(msg({ data: envelope(), id: 'cur-9' }));
    expect(op).toEqual({
      seq: 1,
      ts: 't',
      city: 'c',
      agent: 'gastown.nux',
      bead: 'bead-1',
      model: 'claude-opus-4-8',
      provider: 'claude',
      operation: 'session.submit',
      result: 'success',
      ok: true,
      durationMs: 1200,
      opId: 'op-1',
      cursor: 'cur-9',
    });
  });

  it('includes token and cost fields only when the supervisor measured them', () => {
    const measured = parseWorkerOperation(
      msg({ data: envelope({ prompt_tokens: 1000, completion_tokens: 40, cost_usd_estimate: 0.012 }) }),
    );
    expect(measured).toMatchObject({ promptTokens: 1000, completionTokens: 40, costUsd: 0.012 });

    // The current /v0 reality: token/cost fields absent → omitted, not zeroed.
    const absent = parseWorkerOperation(msg({ data: envelope() }));
    expect(absent).not.toHaveProperty('promptTokens');
    expect(absent).not.toHaveProperty('completionTokens');
    expect(absent).not.toHaveProperty('costUsd');
  });

  it('drops negative/NaN numeric fields rather than trusting them', () => {
    const op = parseWorkerOperation(msg({ data: envelope({ prompt_tokens: -5, duration_ms: -1 }) }));
    expect(op).not.toHaveProperty('promptTokens');
    expect(op?.durationMs).toBe(0);
  });

  it('falls back through agent/bead/model attribution', () => {
    const op = parseWorkerOperation(
      msg({ data: envelope({ agent_name: undefined, session_name: 'sess-x', bead_id: undefined, model: undefined }) }),
    );
    expect(op).toMatchObject({ agent: 'sess-x', bead: NO_BEAD, model: UNKNOWN_MODEL });

    const bare = parseWorkerOperation(
      msg({ data: envelope({ agent_name: undefined, session_name: undefined }) }),
    );
    expect(bare?.agent).toBe(UNKNOWN_AGENT);
  });

  it('marks operations with an error or failure result as not ok', () => {
    expect(parseWorkerOperation(msg({ data: envelope({ error: 'nope' }) }))?.ok).toBe(false);
    expect(parseWorkerOperation(msg({ data: envelope({ result: 'failed' }) }))?.ok).toBe(false);
  });

  it('ignores non-worker.operation envelopes and noise', () => {
    expect(parseWorkerOperation(msg({ event: 'heartbeat', data: envelope() }))).toBeNull();
    expect(parseWorkerOperation(msg({ data: '' }))).toBeNull();
    expect(parseWorkerOperation(msg({ data: 'not json' }))).toBeNull();
    expect(parseWorkerOperation(msg({ data: 'null' }))).toBeNull(); // valid JSON, but not an object
    expect(
      parseWorkerOperation(msg({ data: JSON.stringify({ type: 'session.updated', seq: 1, payload: {} }) })),
    ).toBeNull();
    expect(
      parseWorkerOperation(msg({ data: JSON.stringify({ type: WORKER_OPERATION_TYPE, payload: {} }) })),
    ).toBeNull(); // no seq
    expect(
      parseWorkerOperation(msg({ data: JSON.stringify({ type: WORKER_OPERATION_TYPE, seq: 1 }) })),
    ).toBeNull(); // no payload
  });

  it('defaults result/provider/operation and reads the finished_at and cache fallbacks', () => {
    // No envelope ts → falls through to the payload's finished_at; result, provider,
    // and operation are absent so each takes its default; cache token fields present.
    const viaFinishedAt = parseWorkerOperation(
      msg({
        data: JSON.stringify({
          type: WORKER_OPERATION_TYPE,
          seq: 3,
          payload: { finished_at: 'fin-ts', cache_creation_tokens: 50, cache_read_tokens: 20 },
        }),
      }),
    );
    expect(viaFinishedAt).toMatchObject({
      result: '',
      ts: 'fin-ts',
      provider: '',
      operation: '(operation)',
      cacheCreationTokens: 50,
      cacheReadTokens: 20,
    });

    // Neither envelope ts nor finished_at → ts defaults to empty string.
    const noTs = parseWorkerOperation(
      msg({ data: JSON.stringify({ type: WORKER_OPERATION_TYPE, seq: 4, payload: {} }) }),
    );
    expect(noTs?.ts).toBe('');
  });
});

// A controllable async-iterable SSE source plus a manually-resolved sleep, so the
// reconnect loop can be advanced one connection at a time (mirrors the status test).
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('TelemetryStream', () => {
  it('streams parsed operations, reports open, then reconnects threading Last-Event-ID', async () => {
    const calls: Array<{ lastEventId?: string }> = [];
    const batches: SSEMessage[][] = [
      [msg({ data: envelope({}, { seq: 1 }), id: 'cur-1' })],
      [msg({ data: envelope({}, { seq: 2 }), id: 'cur-2' })],
    ];
    let i = 0;
    const openStream = (_url: string, opts: { lastEventId?: string }) => {
      calls.push({ lastEventId: opts.lastEventId });
      const batch = batches[i++] ?? [];
      return (async function* () {
        for (const m of batch) yield m;
      })();
    };

    const sleepResolvers: Array<() => void> = [];
    const sleep = (_ms: number, _signal: AbortSignal) =>
      new Promise<void>((resolve) => sleepResolvers.push(resolve));

    const ops: WorkerOperation[] = [];
    const statuses: TelemetryStreamStatus[] = [];
    const stream = new TelemetryStream('http://host', {
      openStream,
      sleep,
      random: () => 0.5,
      options: { baseDelayMs: 10, maxDelayMs: 10, jitterFactor: 0 },
    });
    stream.onEvent((op) => ops.push(op));
    stream.onStatus((s) => statuses.push(s));

    stream.start();
    await tick(); // drain first connection
    expect(ops.map((o) => o.seq)).toEqual([1]);
    expect(statuses.some((s) => s.state === 'open')).toBe(true);

    // First connection ended → backoff scheduled; release it to reconnect.
    expect(sleepResolvers).toHaveLength(1);
    sleepResolvers[0]!();
    await tick();
    await tick();

    expect(ops.map((o) => o.seq)).toEqual([1, 2]);
    // The reconnect must carry the last seen SSE id.
    expect(calls[0]!.lastEventId).toBeUndefined();
    expect(calls[1]!.lastEventId).toBe('cur-1');

    stream.dispose();
  });

  it('keeps running after a connection throws, backing off before retry', async () => {
    let i = 0;
    // First connection rejects on iteration (a dropped socket); the rest stream.
    const failing: AsyncIterable<SSEMessage> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('connection reset')) }),
    };
    const openStream = (_url: string, _opts: unknown) => {
      i += 1;
      if (i === 1) return failing;
      return (async function* () {
        yield msg({ data: envelope({}, { seq: 7 }), id: 'cur-7' });
      })();
    };
    const sleepResolvers: Array<() => void> = [];
    const sleep = () => new Promise<void>((resolve) => sleepResolvers.push(resolve));

    const ops: WorkerOperation[] = [];
    const stream = new TelemetryStream('http://host', {
      openStream,
      sleep,
      random: () => 0,
      options: { baseDelayMs: 5, maxDelayMs: 5, jitterFactor: 0 },
    });
    stream.onEvent((op) => ops.push(op));

    stream.start();
    await tick();
    expect(ops).toHaveLength(0); // first connection threw
    expect(sleepResolvers).toHaveLength(1);
    sleepResolvers[0]!();
    await tick();
    await tick();
    expect(ops.map((o) => o.seq)).toEqual([7]);

    stream.dispose();
  });

  it('exposes the current status, starting from stopped', () => {
    const openStream = (_url: string, opts: { signal?: AbortSignal }) =>
      (async function* () {
        await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
        yield* []; // never yields; parks until aborted (satisfies require-yield)
      })();
    const stream = new TelemetryStream('http://host', { openStream, sleep: () => Promise.resolve() });
    expect(stream.currentStatus).toEqual({ state: 'stopped', detail: 'not started', attempt: 0 });
  });

  it('is idempotent on repeated start()', async () => {
    let opens = 0;
    const openStream = (_url: string, opts: { signal?: AbortSignal }) => {
      opens += 1;
      return (async function* () {
        await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
        yield* []; // never yields; parks until aborted (satisfies require-yield)
      })();
    };
    const stream = new TelemetryStream('http://host', { openStream, sleep: () => Promise.resolve() });
    stream.start();
    stream.start();
    await tick();
    expect(opens).toBe(1);
    stream.dispose();
  });

  it('threads injected fetch and headers into the openSSE options', async () => {
    let captured: { fetch?: unknown; headers?: unknown } | undefined;
    const openStream = (_url: string, opts: { signal?: AbortSignal; fetch?: unknown; headers?: unknown }) => {
      captured = opts;
      return (async function* () {
        await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
        yield* []; // never yields; parks until aborted (satisfies require-yield)
      })();
    };
    const fakeFetch = (async () => new Response('')) as unknown as typeof fetch;
    const stream = new TelemetryStream('http://host', {
      openStream,
      sleep: () => Promise.resolve(),
      fetch: fakeFetch,
      headers: { 'x-h': '1' },
    });

    stream.start();
    await tick();

    expect(captured?.fetch).toBe(fakeFetch);
    expect(captured?.headers).toEqual({ 'x-h': '1' });
    stream.dispose();
  });

  it('drops in-flight operations once the generation changes mid-stream', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const openStream = (_url: string, _opts: unknown) =>
      (async function* () {
        yield msg({ data: envelope({}, { seq: 1 }), id: 'c1' });
        await gate;
        yield msg({ data: envelope({}, { seq: 2 }), id: 'c2' });
      })();
    const stream = new TelemetryStream('http://host', { openStream, sleep: () => Promise.resolve() });
    const ops: WorkerOperation[] = [];
    stream.onEvent((o) => ops.push(o));

    stream.start();
    await tick();
    expect(ops.map((o) => o.seq)).toEqual([1]);

    stream.stop();
    release();
    await tick();

    expect(ops.map((o) => o.seq)).toEqual([1]);
  });

  it('stops cleanly when the server closes the stream after a stop()', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const openStream = (_url: string, _opts: unknown) =>
      (async function* () {
        yield msg({ data: envelope({}, { seq: 1 }), id: 'c1' });
        await gate; // then the generator completes (server closed)
      })();
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };
    const stream = new TelemetryStream('http://host', { openStream, sleep });
    const ops: WorkerOperation[] = [];
    stream.onEvent((o) => ops.push(o));

    stream.start();
    await tick();
    stream.stop();
    release();
    await tick();

    expect(sleepCalls).toEqual([]); // never reached backoff — returned at the post-close alive check
    expect(ops.map((o) => o.seq)).toEqual([1]);
  });

  it('returns from the run loop when aborted during a failed connection', async () => {
    const openStream = (_url: string, _opts: unknown) =>
      (async function* () {
        await Promise.resolve();
        yield* []; // satisfies require-yield; the throw below surfaces in the run loop's catch
        throw new Error('deferred failure');
      })();
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };
    const stream = new TelemetryStream('http://host', { openStream, sleep });

    stream.start();
    stream.stop();
    await tick();
    await tick();

    expect(sleepCalls).toEqual([]);
    expect(stream.currentStatus.state).toBe('stopped');
  });

  it('stringifies a non-Error thrown by the stream for the warn log', async () => {
    const logs: Array<{ level: string; meta?: Record<string, unknown> }> = [];
    const log = (level: string, _message: string, meta?: Record<string, unknown>) => logs.push({ level, meta });
    let i = 0;
    const openStream = (_url: string, opts: { signal?: AbortSignal }) => {
      i += 1;
      if (i === 1) throw 'plain failure';
      return (async function* () {
        await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
        yield* []; // never yields; parks until aborted (satisfies require-yield)
      })();
    };
    const sleepResolvers: Array<() => void> = [];
    const sleep = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        sleepResolvers.push(resolve);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const stream = new TelemetryStream('http://host', { openStream, sleep, log, random: () => 0 });

    stream.start();
    await tick();

    expect(logs.some((l) => l.level === 'warn' && l.meta?.error === 'plain failure')).toBe(true);
    sleepResolvers.shift()?.();
    await tick();
    stream.dispose();
  });

  it('uses the built-in sleep and random when none are injected', async () => {
    let i = 0;
    const openStream = (_url: string, opts: { signal?: AbortSignal }) => {
      i += 1;
      if (i === 1) throw new Error('first connection fails');
      return (async function* () {
        yield msg({ data: envelope({}, { seq: 7 }), id: 'c7' });
        await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
        yield* []; // never yields; parks until aborted (satisfies require-yield)
      })();
    };
    // No sleep and no random injected → exercises defaultSleep + Math.random (jitter 0 keeps it deterministic).
    const stream = new TelemetryStream('http://host', {
      openStream,
      options: { baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });
    const ops: WorkerOperation[] = [];
    stream.onEvent((o) => ops.push(o));

    stream.start();
    await new Promise<void>((r) => setTimeout(r, 25));

    expect(ops.map((o) => o.seq)).toEqual([7]);
    stream.dispose();
  });

  it('the built-in sleep rejects and the loop exits cleanly when aborted during backoff', async () => {
    const openStream = (_url: string, _opts: unknown) => {
      throw new Error('always fails');
    };
    const stream = new TelemetryStream('http://host', {
      openStream,
      random: () => 0,
      options: { baseDelayMs: 10_000, maxDelayMs: 10_000, jitterFactor: 0 },
    });

    stream.start();
    await tick();
    expect(stream.currentStatus.state).toBe('reconnecting');

    stream.stop();
    await tick();

    expect(stream.currentStatus.state).toBe('stopped');
  });
});
