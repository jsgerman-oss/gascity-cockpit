import { describe, expect, it } from 'vitest';
import {
  formatCompact,
  formatCost,
  formatDurationMs,
  formatTokenBreakdown,
  formatTokens,
  modelDescription,
  modelStatusKind,
  NOT_MEASURED,
  scopeDescription,
  scopeStatusKind,
  streamStatusKind,
  totalsSummary,
} from './format';
import { emptyTokenTotals } from './types';
import type { ModelRollup, ScopeRollup, TelemetryTotals, TokenTotals } from './types';

const tokens = (over: Partial<TokenTotals> = {}): TokenTotals => ({ ...emptyTokenTotals(), ...over });

const model = (over: Partial<ModelRollup> = {}): ModelRollup => ({
  model: 'm1',
  providers: ['claude'],
  operations: 1,
  succeeded: 1,
  failed: 0,
  durationMs: 100,
  tokens: emptyTokenTotals(),
  costUsd: null,
  costMeasuredOps: 0,
  lastTs: 't',
  lastSeq: 1,
  ...over,
});

const scope = (over: Partial<ScopeRollup> = {}): ScopeRollup => ({
  key: 'A',
  operations: 1,
  succeeded: 1,
  failed: 0,
  durationMs: 100,
  tokens: emptyTokenTotals(),
  costUsd: null,
  costMeasuredOps: 0,
  models: [model()],
  lastTs: 't',
  lastSeq: 1,
  ...over,
});

describe('number formatting', () => {
  it('formats counts compactly', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(940)).toBe('940');
    expect(formatCompact(1000)).toBe('1k');
    expect(formatCompact(1200)).toBe('1.2k');
    expect(formatCompact(45_000)).toBe('45k');
    expect(formatCompact(1_500_000)).toBe('1.5M');
  });

  it('formats durations, using a dash for nothing', () => {
    expect(formatDurationMs(0)).toBe(NOT_MEASURED);
    expect(formatDurationMs(-5)).toBe(NOT_MEASURED);
    expect(formatDurationMs(350)).toBe('350ms');
    expect(formatDurationMs(1000)).toBe('1s');
    expect(formatDurationMs(4200)).toBe('4.2s');
    expect(formatDurationMs(125_000)).toBe('2m 5s');
    expect(formatDurationMs(3_660_000)).toBe('1h 1m');
  });
});

describe('token & cost formatting (graceful degradation)', () => {
  it('shows a dash when nothing was measured', () => {
    expect(formatTokens(tokens())).toBe(NOT_MEASURED);
    expect(formatTokenBreakdown(tokens())).toBe(NOT_MEASURED);
    expect(formatCost(null, 0)).toBe(NOT_MEASURED);
    expect(formatCost(1.23, 0)).toBe(NOT_MEASURED); // measuredOps gates it
  });

  it('shows totals when measured', () => {
    expect(formatTokens(tokens({ promptIn: 1000, completionOut: 200, measuredOps: 2 }))).toBe('1.2k tok');
    expect(formatTokenBreakdown(tokens({ promptIn: 1000, completionOut: 200, measuredOps: 2 }))).toBe(
      'in 1k · out 200',
    );
    expect(
      formatTokenBreakdown(tokens({ promptIn: 10, completionOut: 5, cacheRead: 99, measuredOps: 1 })),
    ).toContain('cache w 0 / r 99');
    expect(formatCost(0, 1)).toBe('$0.00');
    expect(formatCost(0.0012, 1)).toBe('$0.0012');
    expect(formatCost(1.5, 3)).toBe('$1.50');
  });
});

describe('scope & model descriptions', () => {
  it('omits token/cost segments when unmeasured', () => {
    expect(scopeDescription(scope())).toBe('1 op · m1 · 100ms');
  });

  it('includes model coverage, failures, tokens and cost when present', () => {
    const desc = scopeDescription(
      scope({
        operations: 5,
        failed: 1,
        durationMs: 2000,
        tokens: tokens({ promptIn: 1000, completionOut: 200, measuredOps: 5 }),
        costUsd: 0.05,
        costMeasuredOps: 5,
        models: [model(), model({ model: 'm2' })],
      }),
    );
    expect(desc).toContain('5 ops');
    expect(desc).toContain('2 models');
    expect(desc).toContain('1 failed');
    expect(desc).toContain('1.2k tok');
    expect(desc).toContain('$0.05');
  });

  it('summarises a model line', () => {
    expect(modelDescription(model({ operations: 3, providers: ['claude'], durationMs: 300 }))).toBe(
      '3 ops · claude · 300ms',
    );
  });
});

describe('status kinds', () => {
  it('maps scope health to an icon kind', () => {
    expect(scopeStatusKind(scope({ operations: 0, succeeded: 0 }))).toBe('idle');
    expect(scopeStatusKind(scope({ operations: 2, succeeded: 0, failed: 2 }))).toBe('error');
    expect(scopeStatusKind(scope({ operations: 2, succeeded: 1, failed: 1 }))).toBe('warn');
    expect(scopeStatusKind(scope({ operations: 2, succeeded: 2, failed: 0 }))).toBe('ok');
  });

  it('maps model health and stream state', () => {
    expect(modelStatusKind(model({ succeeded: 0, failed: 1 }))).toBe('error');
    expect(streamStatusKind(null)).toBe('off');
    expect(streamStatusKind({ state: 'open', detail: '', attempt: 0 })).toBe('ok');
    expect(streamStatusKind({ state: 'reconnecting', detail: '', attempt: 2 })).toBe('warn');
  });
});

describe('totalsSummary', () => {
  it('summarises the header with graceful degradation', () => {
    const base: TelemetryTotals = {
      operations: 124,
      succeeded: 120,
      failed: 4,
      durationMs: 123_000,
      tokens: emptyTokenTotals(),
      costUsd: null,
      costMeasuredOps: 0,
      agents: 6,
      beads: 12,
    };
    const summary = totalsSummary(base);
    expect(summary).toContain('124 ops');
    expect(summary).toContain('6 agents');
    expect(summary).toContain('12 beads');
    expect(summary).not.toContain('tok'); // unmeasured → omitted
  });
});
