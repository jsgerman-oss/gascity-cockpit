import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_ID, WINDOWS, deriveMetrics, windowById } from './derive.ts';
import type { MetricEvent, MetricWindowId } from './types.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-06-07T00:00:00Z');
const W24 = windowById('24h');
const START = NOW - W24.hours * HOUR;

function ev(kind: 'closed' | 'rejected', over: Partial<MetricEvent> = {}): MetricEvent {
  return {
    kind,
    tsMs: NOW - HOUR,
    beadId: 'cockpit-1',
    rig: 'gascity-cockpit',
    agent: 'gascity-cockpit/gastown.refinery',
    city: 'blackrim-hq',
    createdAtMs: null,
    rejectionReason: null,
    ...over,
  };
}

describe('window helpers', () => {
  it('exposes three ordered windows and a 7d default', () => {
    expect(WINDOWS.map((w) => w.id)).toEqual(['24h', '7d', '30d']);
    expect(DEFAULT_WINDOW_ID).toBe('7d');
  });
  it('looks up by id and defaults unknown ids to 7d', () => {
    expect(windowById('30d').hours).toBe(720);
    expect(windowById('bogus' as MetricWindowId).id).toBe('7d');
  });
});

describe('deriveMetrics — empty', () => {
  it('yields a zeroed overall and no groups', () => {
    const m = deriveMetrics([], { window: W24, nowMs: NOW });
    expect(m.overall.throughput.total).toBe(0);
    expect(m.overall.throughput.series).toHaveLength(24);
    expect(m.overall.cycle).toBeNull();
    expect(m.overall.reject).toEqual({ rejects: 0, merges: 0, rate: null });
    expect(m.byRig).toEqual([]);
    expect(m.byAgent).toEqual([]);
  });
});

describe('deriveMetrics — throughput + bucketing', () => {
  it('counts closes and places them in hourly buckets', () => {
    const events = [
      ev('closed', { tsMs: START + 10 * 60_000 }), // bucket 0
      ev('closed', { tsMs: START + 20 * 60_000 }), // bucket 0
      ev('closed', { tsMs: NOW - 30 * 60_000 }), // bucket 23
    ];
    const m = deriveMetrics(events, { window: W24, nowMs: NOW });
    expect(m.overall.throughput.total).toBe(3);
    expect(m.overall.throughput.series[0]).toBe(2);
    expect(m.overall.throughput.series[23]).toBe(1);
    expect(m.overall.throughput.series.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('clamps an event exactly at now into the last bucket and includes it', () => {
    const m = deriveMetrics([ev('closed', { tsMs: NOW })], { window: W24, nowMs: NOW });
    expect(m.overall.throughput.series[23]).toBe(1);
  });
});

describe('deriveMetrics — window filtering', () => {
  it('excludes events at/before the window start and after now', () => {
    const events = [
      ev('closed', { tsMs: START }), // at start → excluded
      ev('closed', { tsMs: START - HOUR }), // before → excluded
      ev('closed', { tsMs: NOW + HOUR }), // future → excluded
      ev('closed', { tsMs: START + 1 }), // just inside → included
    ];
    const m = deriveMetrics(events, { window: W24, nowMs: NOW });
    expect(m.overall.throughput.total).toBe(1);
  });
});

describe('deriveMetrics — cycle time', () => {
  it('computes count, mean, p50, p90, and max from durations', () => {
    const durations = [1, 2, 3, 4].map((h) => h * HOUR);
    const events = durations.map((d, i) =>
      ev('closed', { tsMs: NOW - (i + 1) * 60_000, createdAtMs: NOW - (i + 1) * 60_000 - d }),
    );
    const m = deriveMetrics(events, { window: W24, nowMs: NOW });
    const c = m.overall.cycle!;
    expect(c.count).toBe(4);
    expect(c.meanMs).toBe(2.5 * HOUR);
    expect(c.p50Ms).toBe(2 * HOUR);
    expect(c.p90Ms).toBe(4 * HOUR);
    expect(c.maxMs).toBe(4 * HOUR);
  });

  it('skips closes with no creation time or a creation after the close', () => {
    const events = [
      ev('closed', { tsMs: NOW - HOUR, createdAtMs: null }),
      ev('closed', { tsMs: NOW - HOUR, createdAtMs: NOW }), // created after close (skew)
    ];
    const m = deriveMetrics(events, { window: W24, nowMs: NOW });
    expect(m.overall.throughput.total).toBe(2);
    expect(m.overall.cycle).toBeNull();
  });
});

describe('deriveMetrics — reject rate', () => {
  it('rate is rejects / (rejects + merges)', () => {
    const events = [
      ev('closed', { beadId: 'cockpit-1' }),
      ev('closed', { beadId: 'cockpit-2' }),
      ev('closed', { beadId: 'cockpit-3' }),
      ev('rejected', { beadId: 'cockpit-4', rejectionReason: 'conflict' }),
    ];
    const r = deriveMetrics(events, { window: W24, nowMs: NOW }).overall.reject;
    expect(r).toEqual({ rejects: 1, merges: 3, rate: 0.25 });
  });

  it('de-dupes a standing rejection by bead + reason but counts a new reason', () => {
    const events = [
      ev('rejected', { beadId: 'cockpit-9', rejectionReason: 'conflict' }),
      ev('rejected', { beadId: 'cockpit-9', rejectionReason: 'conflict' }), // duplicate episode
      ev('rejected', { beadId: 'cockpit-9', rejectionReason: 'tests failed' }), // distinct episode
    ];
    const r = deriveMetrics(events, { window: W24, nowMs: NOW }).overall.reject;
    expect(r.rejects).toBe(2);
    expect(r.merges).toBe(0);
    expect(r.rate).toBe(1);
  });

  it('keys a reject even when the reason is missing', () => {
    const r = deriveMetrics([ev('rejected', { beadId: 'cockpit-x', rejectionReason: null })], {
      window: W24,
      nowMs: NOW,
    }).overall.reject;
    expect(r.rejects).toBe(1);
  });
});

describe('deriveMetrics — grouping', () => {
  it('splits into per-rig and per-agent groups, busiest first', () => {
    const events = [
      ev('closed', { beadId: 'cockpit-1', rig: 'gascity-cockpit', agent: 'a1' }),
      ev('closed', { beadId: 'cockpit-2', rig: 'gascity-cockpit', agent: 'a1' }),
      ev('closed', { beadId: 'cockpit-3', rig: 'gascity-cockpit', agent: 'a2' }),
      ev('closed', { beadId: 'nim-1', rig: 'nimbus', agent: 'a2' }),
    ];
    const m = deriveMetrics(events, { window: W24, nowMs: NOW });

    expect(m.byRig.map((g) => [g.id, g.throughput.total])).toEqual([
      ['gascity-cockpit', 3],
      ['nimbus', 1],
    ]);
    expect(m.byAgent.map((g) => [g.id, g.throughput.total])).toEqual([
      ['a1', 2],
      ['a2', 2],
    ]);
    // Overall aggregates across every group.
    expect(m.overall.throughput.total).toBe(4);
  });
});
