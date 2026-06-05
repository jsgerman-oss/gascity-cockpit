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
});
