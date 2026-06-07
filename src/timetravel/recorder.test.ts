import { describe, expect, it, vi } from 'vitest';
import { EventTimeline } from './recorder';
import type { FleetEvent } from '../status/index.ts';

const event = (seq: number, over: Partial<FleetEvent> = {}): FleetEvent => ({
  seq,
  type: 'session.updated',
  ts: `2026-06-05T00:00:${String(seq).padStart(2, '0')}Z`,
  actor: 'furiosa',
  city: 'blackrim-hq',
  ...over,
});

describe('EventTimeline', () => {
  it('starts empty', () => {
    const tl = new EventTimeline();
    expect(tl.size).toBe(0);
    expect(tl.bounds()).toBeNull();
    expect(tl.snapshot()).toEqual({ rows: [], bounds: null });
  });

  it('records events chronologically (oldest first), unlike the newest-first feed', () => {
    const tl = new EventTimeline();
    tl.record(event(1));
    tl.record(event(2));
    tl.record(event(3));
    expect(tl.snapshot().rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('fires onDidRecord once per newly-recorded event', () => {
    const tl = new EventTimeline();
    const seen: number[] = [];
    tl.onDidRecord((e) => seen.push(e.seq));
    tl.record(event(1));
    tl.record(event(2));
    expect(seen).toEqual([1, 2]);
  });

  it('drops events re-delivered across a reconnect (seq <= max seen)', () => {
    const tl = new EventTimeline();
    const listener = vi.fn();
    tl.onDidRecord(listener);
    tl.record(event(1));
    tl.record(event(2));
    // Reconnect replays the cursor boundary: seq 2 again, then a fresh 3.
    tl.record(event(2));
    tl.record(event(3));
    expect(tl.snapshot().rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(listener).toHaveBeenCalledTimes(3); // the duplicate did not fire
  });

  it('bounds report the span of the recording', () => {
    const tl = new EventTimeline();
    tl.record(event(5, { ts: 'a' }));
    tl.record(event(9, { ts: 'b' }));
    expect(tl.bounds()).toEqual({ count: 2, firstSeq: 5, lastSeq: 9, firstTs: 'a', lastTs: 'b' });
  });

  it('caps the ring buffer, dropping the oldest events', () => {
    const tl = new EventTimeline(3);
    tl.record(event(1));
    tl.record(event(2));
    tl.record(event(3));
    tl.record(event(4));
    expect(tl.snapshot().rows.map((r) => r.seq)).toEqual([2, 3, 4]);
    // The seq high-water mark survives eviction, so a dropped seq cannot return.
    tl.record(event(2));
    expect(tl.snapshot().rows.map((r) => r.seq)).toEqual([2, 3, 4]);
  });

  it('clear() resets the buffer and the seq de-dup state (restart epoch)', () => {
    const tl = new EventTimeline();
    tl.record(event(7));
    tl.clear();
    expect(tl.size).toBe(0);
    expect(tl.bounds()).toBeNull();
    // After a restart the seq counter resets; a low seq must be accepted again.
    tl.record(event(1));
    expect(tl.snapshot().rows.map((r) => r.seq)).toEqual([1]);
  });

  it('snapshot projects rows with the feed presentation and severity tint', () => {
    const tl = new EventTimeline();
    tl.record(event(1, { type: 'session.crashed', message: 'boom' }));
    const [row] = tl.snapshot().rows;
    expect(row.label).toBe('session.crashed');
    expect(row.kind).toBe('error');
    expect(row.message).toBe('boom');
  });

  it('exposes its capacity so a capture can replay with the same cap', () => {
    expect(new EventTimeline(7).capacity).toBe(7);
    expect(new EventTimeline().capacity).toBe(1000); // TIMELINE_CAP default
  });

  it('events() returns the raw chronological window as a detached copy', () => {
    const tl = new EventTimeline();
    tl.record(event(1));
    tl.record(event(2));
    const exported = tl.events();
    expect(exported.map((e) => e.seq)).toEqual([1, 2]);
    // Mutating the returned array must not disturb the recording (it's a copy).
    exported.push(event(99));
    expect(tl.size).toBe(2);
    expect(tl.events().map((e) => e.seq)).toEqual([1, 2]);
  });

  it('events() reflects de-dup and cap, matching what snapshot() projects', () => {
    const tl = new EventTimeline(2);
    tl.record(event(1));
    tl.record(event(2));
    tl.record(event(2)); // duplicate seq — dropped
    tl.record(event(3)); // overflows the cap-2 ring — evicts seq 1
    expect(tl.events().map((e) => e.seq)).toEqual([2, 3]);
    expect(tl.snapshot().rows.map((r) => r.seq)).toEqual([2, 3]);
  });

  it('stops firing after dispose', () => {
    const tl = new EventTimeline();
    const listener = vi.fn();
    tl.onDidRecord(listener);
    tl.dispose();
    tl.record(event(1));
    expect(listener).not.toHaveBeenCalled();
  });
});
