// Presentation helpers for the metrics pane (cockpit-3x7).
//
// Pure string/number formatting kept out of the `vscode` glue so it is unit
// tested. A tree view has no charting canvas, so the time series is drawn as a
// Unicode sparkline in the row description — the same "honest text rendering"
// the rest of the Cockpit uses.
import type { CycleStats, GroupMetrics, MetricsModel, RejectStats, ThroughputStats } from './types.ts';

/** Eighth-block bars, low→high, for {@link sparkline}. */
const SPARK_TICKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Round to one decimal place, dropping a trailing `.0`. */
function round1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/**
 * Render counts as an eighth-block sparkline. An all-zero series renders as a
 * flat baseline; any non-zero bucket is lifted at least one tick above empty so
 * a single close is never invisible next to a busy bucket.
 */
export function sparkline(series: readonly number[]): string {
  if (series.length === 0) return '';
  const max = Math.max(...series);
  if (max <= 0) return SPARK_TICKS[0].repeat(series.length);
  const top = SPARK_TICKS.length - 1;
  return series
    .map((v) => {
      if (v <= 0) return SPARK_TICKS[0];
      return SPARK_TICKS[Math.max(1, Math.min(top, Math.round((v / max) * top)))];
    })
    .join('');
}

/** Format a duration in ms with a single, scale-appropriate unit. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < MS_PER_MINUTE) return `${Math.round(ms / MS_PER_SECOND)}s`;
  if (ms < MS_PER_HOUR) return `${round1(ms / MS_PER_MINUTE)}m`;
  if (ms < 2 * MS_PER_DAY) return `${round1(ms / MS_PER_HOUR)}h`;
  return `${round1(ms / MS_PER_DAY)}d`;
}

/** Format a 0..1 rate as a whole percent, or `—` when undefined. */
export function formatPercent(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** Compact integer count (e.g. `1.2k` past 10k). */
export function formatCount(n: number): string {
  if (n < 10_000) return `${n}`;
  if (n < 1_000_000) return `${round1(n / 1000)}k`;
  return `${round1(n / 1_000_000)}M`;
}

/** Row description for the throughput metric: total + sparkline. */
export function throughputDescription(t: ThroughputStats, bucketUnit: string): string {
  const closed = `${formatCount(t.total)} closed`;
  if (t.total === 0) return `${closed} · no activity`;
  return `${closed} · ${sparkline(t.series)} /${bucketUnit}`;
}

/** Row description for the cycle-time metric. */
export function cycleDescription(c: CycleStats | null): string {
  if (!c) return 'no open→closed timing in window';
  return `median ${formatDuration(c.p50Ms)} · p90 ${formatDuration(c.p90Ms)} · max ${formatDuration(c.maxMs)} (n=${c.count})`;
}

/** Row description for the refinery reject-rate metric. */
export function rejectDescription(r: RejectStats): string {
  if (r.rate === null) return 'no submissions in window';
  return `${formatPercent(r.rate)} · ${r.rejects} rejected / ${r.rejects + r.merges} submitted`;
}

/** One-line summary of a group, for its collapsible node. */
export function groupDescription(g: GroupMetrics): string {
  const parts = [`${formatCount(g.throughput.total)} closed`];
  if (g.cycle) parts.push(`~${formatDuration(g.cycle.p50Ms)}`);
  if (g.reject.rate !== null && g.reject.rejects > 0) parts.push(`${formatPercent(g.reject.rate)} reject`);
  return parts.join(' · ');
}

/** The pane's title summary: overall throughput + window. */
export function overallSummary(model: MetricsModel): string {
  const o = model.overall;
  const cycle = o.cycle ? ` · median ${formatDuration(o.cycle.p50Ms)}` : '';
  const reject = o.reject.rate !== null ? ` · ${formatPercent(o.reject.rate)} reject` : '';
  return `${formatCount(o.throughput.total)} closed${cycle}${reject} · ${model.window.label}`;
}

/** Accessible, screen-reader-friendly label for a group node. */
export function accessibleGroup(g: GroupMetrics): string {
  const bits = [`${g.label}`, `${g.throughput.total} closed`];
  if (g.cycle) bits.push(`median cycle ${formatDuration(g.cycle.p50Ms)}`);
  if (g.reject.rate !== null) bits.push(`reject rate ${formatPercent(g.reject.rate)}`);
  return bits.join(', ');
}
