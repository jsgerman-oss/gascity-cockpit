import { describe, expect, it, vi } from 'vitest';
import { FleetStatusStore } from './store';
import type { FleetEvent, FleetSnapshot } from './types';

const snapshot = (over: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
  health: { status: 'ok', version: '0.1.0', uptime_sec: 1, cities_total: 1, cities_running: 1, startup: { ready: true } },
  cities: [{ name: 'blackrim-hq', path: '/x', running: true }],
  agentsByCity: { 'blackrim-hq': [] },
  sessionsByCity: { 'blackrim-hq': [] },
  partialErrors: [],
  ...over,
});

const event = (seq: number, over: Partial<FleetEvent> = {}): FleetEvent => ({
  seq,
  type: 'session.updated',
  ts: 't',
  actor: 'a',
  city: 'blackrim-hq',
  ...over,
});

describe('FleetStatusStore', () => {
  it('starts empty', () => {
    const store = new FleetStatusStore();
    expect(store.state).toEqual({
      health: null,
      cities: [],
      agentsByCity: {},
      sessionsByCity: {},
      events: [],
      partialErrors: [],
      eventStream: null,
      lastError: null,
      loading: false,
    });
  });

  it('tracks the loading flag and clears it on a terminal transition', () => {
    const store = new FleetStatusStore();
    const listener = vi.fn();
    store.onDidChange(listener);

    store.setLoading(true);
    expect(store.state.loading).toBe(true);
    // Idempotent: setting the same value does not re-fire.
    store.setLoading(true);
    expect(listener).toHaveBeenCalledTimes(1);

    // A landed snapshot means we are no longer loading.
    store.applySnapshot(snapshot());
    expect(store.state.loading).toBe(false);

    // An error is also a terminal answer.
    store.setLoading(true);
    store.setError('boom');
    expect(store.state.loading).toBe(false);

    // …as is clearing the snapshot on disconnect.
    store.setLoading(true);
    store.clearSnapshot('gone');
    expect(store.state.loading).toBe(false);
  });

  it('applies a snapshot and fires a change', () => {
    const store = new FleetStatusStore();
    const listener = vi.fn();
    store.onDidChange(listener);

    store.setError('stale');
    store.applySnapshot(snapshot());

    expect(store.state.health?.version).toBe('0.1.0');
    expect(store.state.cities).toHaveLength(1);
    // A successful snapshot clears any prior error.
    expect(store.state.lastError).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('prepends events newest-first and caps the ring buffer', () => {
    const store = new FleetStatusStore(3);
    store.addEvent(event(1));
    store.addEvent(event(2));
    store.addEvent(event(3));
    store.addEvent(event(4));

    expect(store.state.events.map((e) => e.seq)).toEqual([4, 3, 2]);
  });

  it('preserves the event feed across snapshots', () => {
    const store = new FleetStatusStore();
    store.addEvent(event(1));
    store.applySnapshot(snapshot({ cities: [] }));
    expect(store.state.events.map((e) => e.seq)).toEqual([1]);
  });

  it('records stream status and errors', () => {
    const store = new FleetStatusStore();
    store.setEventStreamStatus({ state: 'open', detail: 'streaming', attempt: 0 });
    expect(store.state.eventStream?.state).toBe('open');
    store.setError('boom');
    expect(store.state.lastError).toBe('boom');
  });

  it('clearSnapshot blanks fleet data but keeps events and sets the reason', () => {
    const store = new FleetStatusStore();
    store.applySnapshot(snapshot());
    store.addEvent(event(7));

    store.clearSnapshot('API unavailable');

    expect(store.state.health).toBeNull();
    expect(store.state.cities).toEqual([]);
    expect(store.state.agentsByCity).toEqual({});
    expect(store.state.lastError).toBe('API unavailable');
    expect(store.state.events.map((e) => e.seq)).toEqual([7]);
  });
});
