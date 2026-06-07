import { describe, expect, it } from 'vitest';
import {
  captureScenario,
  captureTimelineScenario,
  coerceScenario,
  diffSnapshots,
  parseScenario,
  runScenario,
  SCENARIO_FORMAT_VERSION,
  serializeScenario,
  type ReplayScenario,
} from './scenario';
import { EventTimeline } from './recorder';
import type { FleetEvent, TimelineRow, TimelineSnapshot } from './types';

const event = (seq: number, over: Partial<FleetEvent> = {}): FleetEvent => ({
  seq,
  type: 'session.updated',
  ts: `2026-06-06T00:00:${String(seq).padStart(2, '0')}Z`,
  actor: 'gastown.furiosa',
  city: 'blackrim-hq',
  ...over,
});

const row = (over: Partial<TimelineRow> = {}): TimelineRow => ({
  seq: 1,
  type: 'session.updated',
  ts: '2026-06-06T00:00:01Z',
  actor: 'gastown.furiosa',
  city: 'blackrim-hq',
  subject: '',
  message: '',
  label: 'session.updated',
  desc: 'blackrim-hq · gastown.furiosa',
  kind: 'ok',
  ...over,
});

describe('captureScenario', () => {
  it('replays the events to derive the expected snapshot', () => {
    const sc = captureScenario('basic', [event(1), event(2)]);
    expect(sc.version).toBe(SCENARIO_FORMAT_VERSION);
    expect(sc.name).toBe('basic');
    expect(sc.expected.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(sc.expected.bounds).toEqual({
      count: 2,
      firstSeq: 1,
      lastSeq: 2,
      firstTs: '2026-06-06T00:00:01Z',
      lastTs: '2026-06-06T00:00:02Z',
    });
  });

  it('defaults the cap and omits optional metadata when not given', () => {
    const sc = captureScenario('no-meta', [event(1)]);
    expect(sc.cap).toBe(1000); // TIMELINE_CAP
    expect('description' in sc).toBe(false);
    expect('capturedAt' in sc).toBe(false);
  });

  it('records the description and capturedAt when provided', () => {
    const sc = captureScenario('meta', [event(1)], {
      description: 'why this matters',
      capturedAt: '2026-06-06T00:00:00Z',
    });
    expect(sc.description).toBe('why this matters');
    expect(sc.capturedAt).toBe('2026-06-06T00:00:00Z');
  });

  it('stores the raw events verbatim, including reconnect duplicates', () => {
    // Duplicate seq 2 is preserved in events but dropped from the derived state.
    const sc = captureScenario('dup', [event(1), event(2), event(2), event(3)]);
    expect(sc.events.map((e) => e.seq)).toEqual([1, 2, 2, 3]);
    expect(sc.expected.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('honours a cap override so eviction is captured', () => {
    const sc = captureScenario('cap', [event(1), event(2), event(3)], { cap: 2 });
    expect(sc.cap).toBe(2);
    expect(sc.expected.rows.map((r) => r.seq)).toEqual([2, 3]);
  });

  it('clones events keeping only defined optional fields', () => {
    const sc = captureScenario('clone', [
      event(1, { subject: 's', message: 'm', cursor: 'c' }),
      event(2, { subject: undefined, message: undefined, cursor: undefined }),
    ]);
    expect(sc.events[0]).toEqual({
      seq: 1,
      type: 'session.updated',
      ts: '2026-06-06T00:00:01Z',
      actor: 'gastown.furiosa',
      city: 'blackrim-hq',
      subject: 's',
      message: 'm',
      cursor: 'c',
    });
    expect('subject' in sc.events[1]).toBe(false);
    expect('message' in sc.events[1]).toBe(false);
    expect('cursor' in sc.events[1]).toBe(false);
  });

  it('captures an empty window as null bounds and no rows', () => {
    const sc = captureScenario('empty', []);
    expect(sc.expected).toEqual({ rows: [], bounds: null });
  });
});

describe('captureTimelineScenario', () => {
  it('captures the live recorder window and its cap', () => {
    const timeline = new EventTimeline(3);
    timeline.record(event(1));
    timeline.record(event(2));
    const sc = captureTimelineScenario(timeline, 'from-live');
    expect(sc.cap).toBe(3);
    expect(sc.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(sc.expected.rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('lets options override the recorder cap', () => {
    const timeline = new EventTimeline(10);
    timeline.record(event(1));
    const sc = captureTimelineScenario(timeline, 'override', { cap: 5, description: 'd' });
    expect(sc.cap).toBe(5);
    expect(sc.description).toBe('d');
  });
});

describe('runScenario', () => {
  it('reports no drift when replay reproduces the frozen snapshot', () => {
    const sc = captureScenario('clean', [event(1), event(2)]);
    const result = runScenario(sc);
    expect(result).toEqual({ scenario: 'clean', ok: true, drift: [] });
  });

  it('detects drift when the frozen snapshot disagrees with the replay', () => {
    const sc = captureScenario('tampered', [event(1)]);
    // Corrupt the frozen expectation: the replay will re-derive the real value.
    sc.expected.rows[0].label = 'WRONG';
    const result = runScenario(sc);
    expect(result.ok).toBe(false);
    expect(result.drift.some((d) => d.includes('label'))).toBe(true);
  });

  it('replays with the scenario cap so eviction reproduces', () => {
    const sc = captureScenario('evict', [event(1), event(2), event(3)], { cap: 2 });
    expect(runScenario(sc).ok).toBe(true);
  });
});

describe('diffSnapshots', () => {
  const snap = (rows: TimelineRow[], bounds: TimelineSnapshot['bounds']): TimelineSnapshot => ({ rows, bounds });

  it('is empty for identical snapshots (including both-null bounds)', () => {
    expect(diffSnapshots(snap([], null), snap([], null))).toEqual([]);
    const r = row();
    expect(diffSnapshots(snap([r], r.seq === 1 ? boundsFor([r]) : null), snap([{ ...r }], boundsFor([r])))).toEqual([]);
  });

  it('reports a bounds mismatch', () => {
    const drift = diffSnapshots(snap([], null), snap([], { count: 0, firstSeq: 0, lastSeq: 0, firstTs: '', lastTs: '' }));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('bounds:');
    expect(drift[0]).toContain('none'); // the null side renders as "none"
  });

  it('reports a bounds field mismatch between two non-null bounds', () => {
    const a = { count: 1, firstSeq: 1, lastSeq: 1, firstTs: 'x', lastTs: 'x' };
    const b = { ...a, lastSeq: 2 };
    const drift = diffSnapshots(snap([], a), snap([], b));
    expect(drift.some((d) => d.startsWith('bounds:'))).toBe(true);
  });

  it('reports a row-count mismatch', () => {
    const drift = diffSnapshots(snap([row()], boundsFor([row()])), snap([], null));
    expect(drift.some((d) => d.startsWith('row count:'))).toBe(true);
  });

  it('reports per-row, per-field mismatches across the overlap', () => {
    const expected = [row({ seq: 1, label: 'a' })];
    const actual = [row({ seq: 1, label: 'b', kind: 'error' })];
    const drift = diffSnapshots(snap(expected, boundsFor(expected)), snap(actual, boundsFor(actual)));
    expect(drift.some((d) => d.includes('row 0 label:'))).toBe(true);
    expect(drift.some((d) => d.includes('row 0 kind:'))).toBe(true);
  });
});

describe('serializeScenario / parseScenario', () => {
  it('round-trips a scenario through JSON', () => {
    const sc = captureScenario('round', [event(1, { subject: 's', message: 'm' }), event(2)], {
      description: 'd',
      capturedAt: '2026-06-06T00:00:00Z',
    });
    const json = serializeScenario(sc);
    expect(json.endsWith('\n')).toBe(true);
    expect(json).toContain('  "name": "round"'); // 2-space indentation
    const parsed = parseScenario(json);
    expect(parsed).toEqual(sc);
    expect(runScenario(parsed).ok).toBe(true);
  });

  it('throws a helpful error on malformed JSON', () => {
    expect(() => parseScenario('{not json')).toThrow(/not valid JSON/);
  });
});

describe('coerceScenario', () => {
  const valid = (): ReplayScenario =>
    captureScenario('v', [event(1)], { description: 'd', capturedAt: '2026-06-06T00:00:00Z' });

  it('accepts a well-formed scenario and preserves optional fields', () => {
    const sc = coerceScenario(JSON.parse(JSON.stringify(valid())));
    expect(sc.name).toBe('v');
    expect(sc.description).toBe('d');
    expect(sc.capturedAt).toBe('2026-06-06T00:00:00Z');
  });

  it('drops optional fields that are absent or the wrong type', () => {
    const base = JSON.parse(JSON.stringify(valid())) as Record<string, unknown>;
    delete base.description;
    base.capturedAt = 123; // wrong type → dropped
    const sc = coerceScenario(base);
    expect('description' in sc).toBe(false);
    expect('capturedAt' in sc).toBe(false);
  });

  it.each([
    ['a non-object', 42, /must be an object/],
    ['null', null, /must be an object/],
    ['an array', [], /must be an object/],
  ])('rejects %s', (_label, value, re) => {
    expect(() => coerceScenario(value)).toThrow(re as RegExp);
  });

  it('rejects an unsupported version', () => {
    const bad = { ...JSON.parse(JSON.stringify(valid())), version: 999 };
    expect(() => coerceScenario(bad)).toThrow(/unsupported scenario version 999/);
  });

  it.each([
    ['empty name', { name: '' }, /name must be a non-empty string/],
    ['non-string name', { name: 5 }, /name must be a non-empty string/],
    ['non-integer cap', { cap: 1.5 }, /cap must be a positive integer/],
    ['zero cap', { cap: 0 }, /cap must be a positive integer/],
    ['string cap', { cap: '10' }, /cap must be a positive integer/],
  ])('rejects %s', (_label, patch, re) => {
    const bad = { ...JSON.parse(JSON.stringify(valid())), ...patch };
    expect(() => coerceScenario(bad)).toThrow(re as RegExp);
  });

  it('rejects non-array events', () => {
    const bad = { ...JSON.parse(JSON.stringify(valid())), events: {} };
    expect(() => coerceScenario(bad)).toThrow(/events must be an array/);
  });

  it('rejects a non-object expected', () => {
    const bad = { ...JSON.parse(JSON.stringify(valid())), expected: 'nope' };
    expect(() => coerceScenario(bad)).toThrow(/expected must be an object/);
  });

  it('rejects non-array expected.rows', () => {
    const bad = JSON.parse(JSON.stringify(valid()));
    bad.expected.rows = 'nope';
    expect(() => coerceScenario(bad)).toThrow(/expected.rows must be an array/);
  });

  it('rejects a non-object, non-null expected.bounds', () => {
    const bad = JSON.parse(JSON.stringify(valid()));
    bad.expected.bounds = 7;
    expect(() => coerceScenario(bad)).toThrow(/expected.bounds must be an object or null/);
  });

  it('accepts null expected.bounds (an empty recording)', () => {
    const sc = captureScenario('empty', []);
    expect(coerceScenario(JSON.parse(JSON.stringify(sc))).expected.bounds).toBeNull();
  });
});

/** Bounds matching a row list, for diff tests. */
function boundsFor(rows: TimelineRow[]): TimelineSnapshot['bounds'] {
  if (rows.length === 0) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  return { count: rows.length, firstSeq: first.seq, lastSeq: last.seq, firstTs: first.ts, lastTs: last.ts };
}
