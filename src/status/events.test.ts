import { describe, expect, it } from 'vitest';
import {
  affectsStatusPanes,
  parseFleetEvent,
  SupervisorEventStream,
} from './events';
import type { SSEMessage } from '../api/index';
import type { EventStreamStatus, FleetEvent } from './types';

const msg = (over: Partial<SSEMessage> = {}): SSEMessage => ({
  event: 'message',
  data: '',
  id: undefined,
  retry: undefined,
  ...over,
});

const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'session.updated', seq: 1, ts: 't', actor: 'a', city: 'c', ...over });

describe('parseFleetEvent', () => {
  it('parses a tagged envelope and takes the cursor from the SSE id', () => {
    const event = parseFleetEvent(msg({ data: envelope({ subject: 'sess-1', message: 'woke' }), id: 'cur-9' }));
    expect(event).toEqual({
      seq: 1,
      type: 'session.updated',
      ts: 't',
      actor: 'a',
      city: 'c',
      subject: 'sess-1',
      message: 'woke',
      cursor: 'cur-9',
    });
  });

  it('omits optional fields when absent', () => {
    const event = parseFleetEvent(msg({ data: envelope() }));
    expect(event).not.toHaveProperty('subject');
    expect(event).not.toHaveProperty('message');
    expect(event).not.toHaveProperty('cursor');
  });

  it('drops heartbeats, comments, and empty data', () => {
    expect(parseFleetEvent(msg({ event: 'heartbeat', data: envelope() }))).toBeNull();
    expect(parseFleetEvent(msg({ data: '' }))).toBeNull();
    expect(parseFleetEvent(msg({ data: '   ' }))).toBeNull();
  });

  it('drops malformed or non-event payloads', () => {
    expect(parseFleetEvent(msg({ data: 'not json' }))).toBeNull();
    expect(parseFleetEvent(msg({ data: '"a string"' }))).toBeNull();
    expect(parseFleetEvent(msg({ data: JSON.stringify({ seq: 1 }) }))).toBeNull(); // no type
    expect(parseFleetEvent(msg({ data: JSON.stringify({ type: 'x' }) }))).toBeNull(); // no seq
  });

  it('defaults ts, actor, and city to empty strings when missing or non-string', () => {
    const event = parseFleetEvent(
      msg({ data: JSON.stringify({ type: 'x', seq: 9, ts: 5, actor: null, city: { nested: true } }) }),
    );
    expect(event).toEqual({ seq: 9, type: 'x', ts: '', actor: '', city: '' });
  });
});

describe('affectsStatusPanes', () => {
  it('ignores mail traffic and accepts everything else', () => {
    expect(affectsStatusPanes('mail.sent')).toBe(false);
    expect(affectsStatusPanes('session.updated')).toBe(true);
    expect(affectsStatusPanes('bead.created')).toBe(true);
    expect(affectsStatusPanes('city.suspended')).toBe(true);
    expect(affectsStatusPanes('controller.started')).toBe(true);
  });
});

// A controllable async-iterable SSE source plus a manually-resolved sleep, so
// the reconnect loop can be advanced one connection at a time.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function eventMsg(seq: number, id: string): SSEMessage {
  return msg({ data: envelope({ seq }), id });
}

describe('SupervisorEventStream', () => {
  it('streams events, reports open, then reconnects threading Last-Event-ID', async () => {
    const calls: Array<{ lastEventId?: string }> = [];
    const batches: SSEMessage[][] = [[eventMsg(1, 'cur-1')], [eventMsg(2, 'cur-2')]];
    let i = 0;
    const openStream = (_url: string, opts: { lastEventId?: string }) => {
      calls.push({ lastEventId: opts.lastEventId });
      const batch = batches[i++] ?? [];
      return (async function* () {
        for (const m of batch) yield m;
      })();
    };

    const sleepResolvers: Array<() => void> = [];
    const sleepCalls: number[] = [];
    const sleep = (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        sleepCalls.push(ms);
        sleepResolvers.push(resolve);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    const stream = new SupervisorEventStream('http://api.test/', { openStream, sleep, random: () => 0 });
    const events: FleetEvent[] = [];
    const statuses: EventStreamStatus[] = [];
    stream.onEvent((e) => events.push(e));
    stream.onStatus((s) => statuses.push(s));

    stream.start();
    await tick();

    expect(events.map((e) => e.seq)).toEqual([1]);
    expect(calls).toEqual([{ lastEventId: undefined }]);
    expect(statuses.map((s) => s.state)).toContain('open');
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBeGreaterThan(0);

    sleepResolvers.shift()?.();
    await tick();

    expect(calls[1]).toEqual({ lastEventId: 'cur-1' });
    expect(events.map((e) => e.seq)).toEqual([1, 2]);

    stream.stop();
    expect(stream.currentStatus.state).toBe('stopped');
  });

  it('treats an openStream throw as a failed connection and backs off', async () => {
    let i = 0;
    const openStream = (_url: string, _opts: unknown) => {
      i += 1;
      if (i === 1) throw new Error('connect refused');
      return (async function* () {
        yield eventMsg(5, 'cur-5');
      })();
    };
    const sleepResolvers: Array<() => void> = [];
    const sleep = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        sleepResolvers.push(resolve);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    const stream = new SupervisorEventStream('http://api.test', { openStream, sleep, random: () => 0 });
    const events: FleetEvent[] = [];
    stream.onEvent((e) => events.push(e));

    stream.start();
    await tick();

    expect(i).toBe(1);
    expect(events).toEqual([]);
    expect(stream.currentStatus.state).toBe('reconnecting');

    sleepResolvers.shift()?.();
    await tick();

    expect(events.map((e) => e.seq)).toEqual([5]);
    stream.stop();
  });

  it('stop() aborts the connection and emits a stopped status without reconnecting', async () => {
    const sleepCalls: number[] = [];
    const openStream = (_url: string, opts: { signal?: AbortSignal }) =>
      (async function* () {
        // Park until aborted, then end the stream cleanly.
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield* [];
      })();
    const sleep = (ms: number) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };

    const stream = new SupervisorEventStream('http://api.test', { openStream, sleep });
    const events: FleetEvent[] = [];
    stream.onEvent((e) => events.push(e));

    stream.start();
    await tick();
    expect(stream.currentStatus.state).toBe('connecting');

    stream.stop();
    await tick();

    expect(stream.currentStatus.state).toBe('stopped');
    expect(events).toEqual([]);
    expect(sleepCalls).toEqual([]);
  });

  it('is idempotent on repeated start()', async () => {
    let opens = 0;
    const openStream = (_url: string, opts: { signal?: AbortSignal }) => {
      opens += 1;
      return (async function* () {
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield* [];
      })();
    };
    const stream = new SupervisorEventStream('http://api.test', { openStream, sleep: () => Promise.resolve() });
    stream.start();
    stream.start();
    await tick();
    expect(opens).toBe(1);
    stream.stop();
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
    const stream = new SupervisorEventStream('http://api.test', {
      openStream,
      sleep: () => Promise.resolve(),
      fetch: fakeFetch,
      headers: { 'x-trace': 'abc' },
    });

    stream.start();
    await tick();

    expect(captured?.fetch).toBe(fakeFetch);
    expect(captured?.headers).toEqual({ 'x-trace': 'abc' });
    stream.stop();
  });

  it('drops in-flight events once the generation changes mid-stream', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const openStream = (_url: string, _opts: unknown) =>
      (async function* () {
        yield eventMsg(1, 'cur-1');
        await gate;
        yield eventMsg(2, 'cur-2');
      })();
    const stream = new SupervisorEventStream('http://api.test', { openStream, sleep: () => Promise.resolve() });
    const events: FleetEvent[] = [];
    stream.onEvent((e) => events.push(e));

    stream.start();
    await tick();
    expect(events.map((e) => e.seq)).toEqual([1]);

    stream.stop(); // invalidate the run loop's generation
    release(); // unpark the generator; the next message must be discarded
    await tick();

    expect(events.map((e) => e.seq)).toEqual([1]);
    expect(stream.currentStatus.state).toBe('stopped');
  });

  it('returns from the run loop when aborted during a failed connection', async () => {
    const openStream = (_url: string, _opts: unknown) =>
      (async function* () {
        await Promise.resolve(); // defer the throw past a microtask so stop() can interleave
        yield* []; // satisfies require-yield; the throw below surfaces in the run loop's catch
        throw new Error('deferred failure');
      })();
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };
    const stream = new SupervisorEventStream('http://api.test', { openStream, sleep });

    stream.start();
    stream.stop(); // abort before the deferred failure surfaces
    await tick();
    await tick();

    expect(sleepCalls).toEqual([]); // never reached backoff — returned at the alive check
    expect(stream.currentStatus.state).toBe('stopped');
  });

  it('stringifies a non-Error thrown by the stream for the warn log', async () => {
    const logs: Array<{ level: string; meta?: Record<string, unknown> }> = [];
    const log = (level: string, _message: string, meta?: Record<string, unknown>) => logs.push({ level, meta });
    let i = 0;
    const openStream = (_url: string, opts: { signal?: AbortSignal }) => {
      i += 1;
      if (i === 1) throw 'plain failure'; // non-Error throw
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
    const stream = new SupervisorEventStream('http://api.test', { openStream, sleep, log, random: () => 0 });

    stream.start();
    await tick();

    expect(logs.some((l) => l.level === 'warn' && l.meta?.error === 'plain failure')).toBe(true);
    sleepResolvers.shift()?.();
    await tick();
    stream.stop();
  });

  it('uses the built-in sleep to back off between reconnects when none is injected', async () => {
    let i = 0;
    const openStream = (_url: string, opts: { signal?: AbortSignal }) => {
      i += 1;
      if (i === 1) throw new Error('first connection fails');
      return (async function* () {
        yield eventMsg(7, 'cur-7');
        await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
        yield* []; // never yields; parks until aborted (satisfies require-yield)
      })();
    };
    const stream = new SupervisorEventStream('http://api.test', {
      openStream,
      random: () => 0,
      options: { baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });
    const events: FleetEvent[] = [];
    stream.onEvent((e) => events.push(e));

    stream.start();
    // Wait for the real ~1ms backoff timer to fire and the reconnect to deliver.
    await new Promise<void>((r) => setTimeout(r, 25));

    expect(events.map((e) => e.seq)).toEqual([7]);
    stream.stop();
  });

  it('the built-in sleep rejects and the loop exits cleanly when aborted during backoff', async () => {
    const openStream = (_url: string, _opts: unknown) => {
      throw new Error('always fails');
    };
    const stream = new SupervisorEventStream('http://api.test', {
      openStream,
      random: () => 0,
      options: { baseDelayMs: 10_000, maxDelayMs: 10_000, jitterFactor: 0 },
    });

    stream.start();
    await tick(); // first connection fails, now parked in the built-in sleep on a long timer
    expect(stream.currentStatus.state).toBe('reconnecting');

    stream.stop(); // abort fires the sleep's listener: clearTimeout + reject
    await tick();

    expect(stream.currentStatus.state).toBe('stopped');
  });

  it('dispose() stops the stream and tears down the emitters', async () => {
    const openStream = (_url: string, opts: { signal?: AbortSignal }) =>
      (async function* () {
        await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
        yield* []; // never yields; parks until aborted (satisfies require-yield)
      })();
    const stream = new SupervisorEventStream('http://api.test', { openStream, sleep: () => Promise.resolve() });
    stream.start();
    await tick();
    expect(stream.currentStatus.state).toBe('connecting');

    stream.dispose();
    expect(stream.currentStatus.state).toBe('stopped');
  });
});
