import { describe, expect, it } from 'vitest';
import {
  accessibleGroup,
  cycleDescription,
  formatCount,
  formatDuration,
  formatPercent,
  groupDescription,
  overallSummary,
  rejectDescription,
  sparkline,
  throughputDescription,
} from './format.ts';
import type { CycleStats, GroupMetrics, MetricsModel, RejectStats } from './types.ts';

const HOUR = 3_600_000;

function group(over: Partial<GroupMetrics> = {}): GroupMetrics {
  return {
    id: 'g',
    label: 'gascity-cockpit',
    throughput: { total: 0, series: [] },
    cycle: null,
    reject: { rejects: 0, merges: 0, rate: null },
    ...over,
  };
}

const cycle: CycleStats = { count: 2, meanMs: 1.5 * HOUR, p50Ms: HOUR, p90Ms: 2 * HOUR, maxMs: 2 * HOUR };

describe('sparkline', () => {
  it('renders empty input as an empty string', () => {
    expect(sparkline([])).toBe('');
  });
  it('renders an all-zero series as a flat baseline', () => {
    expect(sparkline([0, 0, 0])).toBe('▁▁▁');
  });
  it('scales to the max and lifts any non-zero bucket above empty', () => {
    expect(sparkline([0, 1, 2, 4])).toBe('▁▃▅█');
    expect(sparkline([0, 1, 100])).toBe('▁▂█'); // a tiny value still clears the baseline
  });
});

describe('formatDuration', () => {
  it('chooses a scale-appropriate unit', () => {
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(90_000)).toBe('1.5m');
    expect(formatDuration(2 * HOUR)).toBe('2h');
    expect(formatDuration(3 * 24 * HOUR)).toBe('3d');
  });
  it('handles unit boundaries', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(HOUR)).toBe('1h');
    expect(formatDuration(2 * 24 * HOUR)).toBe('2d');
  });
  it('returns an em dash for negative or non-finite input', () => {
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('formats a rate or an em dash', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.256)).toBe('26%');
    expect(formatPercent(1)).toBe('100%');
  });
});

describe('formatCount', () => {
  it('renders plain, k, and M scales', () => {
    expect(formatCount(5)).toBe('5');
    expect(formatCount(9999)).toBe('9999');
    expect(formatCount(10_000)).toBe('10k');
    expect(formatCount(1_500_000)).toBe('1.5M');
  });
});

describe('throughputDescription', () => {
  it('marks an empty group and renders a sparkline otherwise', () => {
    expect(throughputDescription({ total: 0, series: [0, 0] }, 'hr')).toBe('0 closed · no activity');
    expect(throughputDescription({ total: 3, series: [1, 2] }, 'hr')).toBe('3 closed · ▅█ /hr');
  });
});

describe('cycleDescription', () => {
  it('describes missing and present cycle stats', () => {
    expect(cycleDescription(null)).toBe('no open→closed timing in window');
    expect(cycleDescription(cycle)).toBe('median 1h · p90 2h · max 2h (n=2)');
  });
});

describe('rejectDescription', () => {
  it('describes no-submissions and a real rate', () => {
    expect(rejectDescription({ rejects: 0, merges: 0, rate: null })).toBe('no submissions in window');
    const r: RejectStats = { rejects: 1, merges: 3, rate: 0.25 };
    expect(rejectDescription(r)).toBe('25% · 1 rejected / 4 submitted');
  });
});

describe('groupDescription', () => {
  it('includes cycle and reject parts only when meaningful', () => {
    expect(
      groupDescription(group({ throughput: { total: 3, series: [3] }, cycle, reject: { rejects: 1, merges: 3, rate: 0.25 } })),
    ).toBe('3 closed · ~1h · 25% reject');
    expect(groupDescription(group({ throughput: { total: 2, series: [2] } }))).toBe('2 closed');
  });
});

describe('overallSummary', () => {
  function model(over: Partial<GroupMetrics>): MetricsModel {
    return {
      window: { id: '7d', label: 'Last 7 days', hours: 168, buckets: 7, bucketUnit: 'day' },
      nowMs: 0,
      overall: group(over),
      byRig: [],
      byAgent: [],
    };
  }
  it('summarizes throughput, cycle, reject, and window', () => {
    expect(overallSummary(model({ throughput: { total: 10, series: [] }, cycle, reject: { rejects: 0, merges: 10, rate: 0 } }))).toBe(
      '10 closed · median 1h · 0% reject · Last 7 days',
    );
  });
  it('omits cycle and reject when absent', () => {
    expect(overallSummary(model({ throughput: { total: 10, series: [] } }))).toBe('10 closed · Last 7 days');
  });
});

describe('accessibleGroup', () => {
  it('builds a screen-reader label with available parts', () => {
    expect(accessibleGroup(group({ throughput: { total: 3, series: [] }, cycle, reject: { rejects: 1, merges: 3, rate: 0.25 } }))).toBe(
      'gascity-cockpit, 3 closed, median cycle 1h, reject rate 25%',
    );
    expect(accessibleGroup(group({ throughput: { total: 0, series: [] } }))).toBe('gascity-cockpit, 0 closed');
  });
});
