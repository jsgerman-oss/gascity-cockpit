import { describe, expect, it } from 'vitest';
import { createCockpitClient, type CockpitClient } from '../api/index';
import { Emitter } from '../discovery/index';
import { jsonResponse, mockFetch, problemResponse } from '../test/helpers';
import { LiveStatus } from './live';
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

function setup() {
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
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
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
});
