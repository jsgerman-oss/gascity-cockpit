import { describe, expect, it } from 'vitest';
import { createCockpitClient, type CockpitClient } from '../api/index';
import { Emitter, type Logger } from '../discovery/index';
import { jsonResponse, mockFetch, problemResponse } from '../test/helpers';
import { LiveStatus, type LiveStatusOptions } from './live';
import { FleetStatusStore } from './store';
import type { SupervisorEventStream } from './events';
import type { CityInfo, EventStreamStatus, FleetEvent } from './types';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const healthBody = {
  status: 'ok',
  version: '0.1.0',
  uptime_sec: 10,
  cities_total: 1,
  cities_running: 1,
  startup: { ready: true },
};

const event = (seq: number, over: Partial<FleetEvent> = {}): FleetEvent => ({
  seq,
  type: 'session.updated',
  ts: 't',
  actor: 'a',
  city: 'alpha',
  ...over,
});

/** A fake event stream exposing only the surface LiveStatus depends on. */
class FakeStream {
  private readonly eventEmitter = new Emitter<FleetEvent>();
  private readonly statusEmitter = new Emitter<EventStreamStatus>();
  readonly onEvent = this.eventEmitter.event;
  readonly onStatus = this.statusEmitter.event;
  started = 0;
  stopped = 0;
  disposed = 0;
  start(): void {
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
  dispose(): void {
    this.disposed += 1;
  }
  emit(e: FleetEvent): void {
    this.eventEmitter.fire(e);
  }
  emitStatus(s: EventStreamStatus): void {
    this.statusEmitter.fire(s);
  }
}

function fakeTimers() {
  let nextId = 0;
  const timers = new Map<number, () => void>();
  return {
    setTimer: (cb: () => void) => {
      const id = ++nextId;
      timers.set(id, cb);
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    size: () => timers.size,
    flushAll: () => {
      const cbs = [...timers.values()];
      timers.clear();
      for (const cb of cbs) cb();
    },
  };
}

function setup(extra: { log?: Logger; realTimers?: boolean; options?: Partial<LiveStatusOptions> } = {}) {
  let cities: CityInfo[] = [{ name: 'alpha', path: '/a', running: true }];
  const setCities = (next: CityInfo[]) => {
    cities = next;
  };
  const mock = mockFetch((req) => {
    const path = new URL(req.url).pathname;
    if (path === '/health') return jsonResponse(healthBody);
    if (path === '/v0/cities') return jsonResponse({ total: cities.length, items: cities });
    if (path.endsWith('/agents')) return jsonResponse({ total: 0, items: [] });
    if (path.endsWith('/sessions')) return jsonResponse({ total: 0, items: [] });
    return problemResponse({ title: '404', status: 404 }, { status: 404 });
  });
  const client = createCockpitClient({ baseUrl: 'http://api.test', fetch: mock.fetch });
  const store = new FleetStatusStore();
  const fake = new FakeStream();
  const timers = fakeTimers();
  const live = new LiveStatus({
    store,
    createClient: (): CockpitClient => client,
    createStream: (): SupervisorEventStream => fake as unknown as SupervisorEventStream,
    // Omit the injected timers to exercise the real setTimeout/clearTimeout defaults.
    ...(extra.realTimers ? {} : { setTimer: timers.setTimer, clearTimer: timers.clearTimer }),
    ...(extra.log ? { log: extra.log } : {}),
    ...(extra.options ? { options: extra.options } : {}),
  });
  return { store, fake, timers, live, setCities };
}

describe('LiveStatus', () => {
  it('takes an initial snapshot and starts the stream on connect', async () => {
    const { store, fake, live } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    expect(fake.started).toBe(1);

    await tick();
    expect(store.state.health?.version).toBe('0.1.0');
    expect(store.state.cities.map((c) => c.name)).toEqual(['alpha']);
  });

  it('marks the store loading on connect and clears it once the snapshot lands', async () => {
    const { store, live } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    // Synchronously after connect, the snapshot is still in flight.
    expect(store.state.loading).toBe(true);

    await tick();
    expect(store.state.loading).toBe(false);
  });

  it('clears the loading flag when a connection is torn down before it loads', () => {
    const { store, live } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    expect(store.state.loading).toBe(true);

    live.disconnect();
    expect(store.state.loading).toBe(false);
  });

  it('forwards stream status into the store', async () => {
    const { store, fake, live } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    await tick();

    fake.emitStatus({ state: 'open', detail: 'streaming', attempt: 0 });
    expect(store.state.eventStream).toEqual({ state: 'open', detail: 'streaming', attempt: 0 });
  });

  it('records an event and debounces a refresh that picks up new data', async () => {
    const { store, fake, timers, live, setCities } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    await tick();

    setCities([
      { name: 'alpha', path: '/a', running: true },
      { name: 'beta', path: '/b', running: true },
    ]);
    fake.emit(event(1, { type: 'session.updated' }));

    expect(store.state.events.map((e) => e.seq)).toEqual([1]);
    expect(timers.size()).toBe(1);

    timers.flushAll();
    await tick();
    expect(store.state.cities.map((c) => c.name)).toEqual(['alpha', 'beta']);
  });

  it('does not schedule a refresh for mail events, but still feeds them', async () => {
    const { store, fake, timers, live } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    await tick();
    expect(timers.size()).toBe(0);

    fake.emit(event(2, { type: 'mail.sent' }));
    expect(store.state.events[0].seq).toBe(2);
    expect(timers.size()).toBe(0);
  });

  it('refreshNow refreshes immediately', async () => {
    const { store, live, setCities } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    await tick();

    setCities([{ name: 'gamma', path: '/g', running: true }]);
    live.refreshNow();
    await tick();
    expect(store.state.cities.map((c) => c.name)).toEqual(['gamma']);
  });

  it('disconnect disposes the stream and ignores later events', async () => {
    const { store, fake, live } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    await tick();

    live.disconnect();
    expect(fake.disposed).toBe(1);

    fake.emit(event(9));
    expect(store.state.events.find((e) => e.seq === 9)).toBeUndefined();
  });

  it('does not apply a debounced refresh after disconnect', async () => {
    const { store, fake, timers, live, setCities } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    await tick();

    fake.emit(event(3));
    expect(timers.size()).toBe(1);

    setCities([{ name: 'should-not-appear', path: '/x', running: true }]);
    live.disconnect();
    timers.flushAll();
    await tick();

    expect(store.state.cities.map((c) => c.name)).not.toContain('should-not-appear');
  });

  it('reconnecting disposes the previous stream', async () => {
    const { fake, live } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    await tick();
    live.connect({ baseUrl: 'http://api.test' });
    expect(fake.disposed).toBe(1);
  });

  it('dispose() tears down the active connection', async () => {
    const { fake, store, live } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    await tick();

    live.dispose();
    expect(fake.disposed).toBe(1);
    expect(store.state.loading).toBe(false);
  });

  it('refreshNow is a no-op while disconnected', async () => {
    const { store, live, setCities } = setup();
    // No client yet — must not throw or mutate.
    live.refreshNow();
    expect(store.state.cities).toEqual([]);

    live.connect({ baseUrl: 'http://api.test' });
    await tick();
    expect(store.state.cities.map((c) => c.name)).toEqual(['alpha']);

    live.disconnect();
    // Client cleared — refreshNow must not pull the now-changed cities.
    setCities([{ name: 'should-not-appear', path: '/x', running: true }]);
    live.refreshNow();
    await tick();
    expect(store.state.cities.map((c) => c.name)).toEqual(['alpha']);
  });

  it('records a snapshot apply failure as a store error and logs it', async () => {
    const logs: Array<{ level: string; meta?: Record<string, unknown> }> = [];
    const { store, live } = setup({ log: (level, _message, meta) => logs.push({ level, meta }) });
    store.applySnapshot = () => {
      throw new Error('apply boom');
    };

    live.connect({ baseUrl: 'http://api.test' });
    await tick();

    expect(store.state.lastError).toContain('snapshot failed');
    expect(store.state.lastError).toContain('apply boom');
    expect(logs.some((l) => l.level === 'warn' && l.meta?.error === 'apply boom')).toBe(true);
  });

  it('stringifies a non-Error snapshot failure', async () => {
    const { store, live } = setup();
    store.applySnapshot = () => {
      throw 'plain failure';
    };

    live.connect({ baseUrl: 'http://api.test' });
    await tick();

    expect(store.state.lastError).toBe('snapshot failed: plain failure');
  });

  it('supersedes an in-flight snapshot when a new refresh starts before it lands', async () => {
    const { store, live } = setup();
    live.connect({ baseUrl: 'http://api.test' });
    // Second refresh while the first is still awaiting fetchFleetSnapshot — the
    // prior AbortController must be aborted and its result discarded.
    live.refreshNow();
    await tick();

    expect(store.state.cities.map((c) => c.name)).toEqual(['alpha']);
  });

  it('falls back to real setTimeout/clearTimeout when no timers are injected', async () => {
    const { store, fake, live, setCities } = setup({ realTimers: true, options: { refreshDebounceMs: 1 } });
    live.connect({ baseUrl: 'http://api.test' });
    await tick();

    // A status-affecting event schedules a debounced refresh on the real timer.
    setCities([
      { name: 'alpha', path: '/a', running: true },
      { name: 'beta', path: '/b', running: true },
    ]);
    fake.emit(event(1));
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(store.state.cities.map((c) => c.name)).toEqual(['alpha', 'beta']);

    // Schedule another, then tear down so the real clearTimeout default runs.
    fake.emit(event(2));
    live.disconnect();
    await new Promise<void>((r) => setTimeout(r, 10));
    // The cleared timer never fired a third refresh.
    expect(store.state.cities.map((c) => c.name)).toEqual(['alpha', 'beta']);
  });
});
