// The metric computation for the "Metrics over time" pane (cockpit-3x7).
//
// Pure and `vscode`-free: given a flat list of normalized {@link MetricEvent}s
// and a window, it produces the {@link MetricsModel} the tree renders. It folds
// each event into an overall accumulator plus per-rig and per-agent ones, then
// summarizes throughput (count + a time-bucketed series for the sparkline),
// cycle time (open→closed duration percentiles), and the refinery reject rate.
import type {
  CycleStats,
  GroupMetrics,
  MetricEvent,
  MetricWindow,
  MetricWindowId,
  MetricsModel,
  RejectStats,
} from './types.ts';

const MS_PER_HOUR = 3_600_000;

/** The selectable reporting windows, in display order. */
export const WINDOWS: readonly MetricWindow[] = [
  { id: '24h', label: 'Last 24 hours', hours: 24, buckets: 24, bucketUnit: 'hr' },
  { id: '7d', label: 'Last 7 days', hours: 168, buckets: 7, bucketUnit: 'day' },
  { id: '30d', label: 'Last 30 days', hours: 720, buckets: 30, bucketUnit: 'day' },
];

/** Default window when none is remembered. */
export const DEFAULT_WINDOW_ID: MetricWindowId = '7d';

/** Look up a window by id, defaulting to the 7-day window for any unknown id. */
export function windowById(id: MetricWindowId): MetricWindow {
  return WINDOWS.find((w) => w.id === id) ?? WINDOWS[1];
}

/** Options for {@link deriveMetrics}. */
export interface DeriveOptions {
  window: MetricWindow;
  /** Inclusive end of the reporting window, epoch ms. */
  nowMs: number;
}

/** Mutable per-group accumulator folded over the in-window events. */
interface Acc {
  id: string;
  label: string;
  /** Per-bucket close counts, oldest→newest. */
  series: number[];
  closed: number;
  /** Cycle durations (ms) for closed beads that carried a creation time. */
  cycle: number[];
  /** De-duped rejection episodes, keyed by `beadId reason`. */
  rejectKeys: Set<string>;
}

function newAcc(id: string, label: string, buckets: number): Acc {
  return { id, label, series: new Array<number>(buckets).fill(0), closed: 0, cycle: [], rejectKeys: new Set() };
}

/** Nearest-rank percentile of a pre-sorted, non-empty ascending array. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

function cycleStats(durations: number[]): CycleStats {
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, d) => acc + d, 0);
  return {
    count: sorted.length,
    meanMs: sum / sorted.length,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    maxMs: sorted[sorted.length - 1],
  };
}

function toGroup(acc: Acc): GroupMetrics {
  const rejects = acc.rejectKeys.size;
  const merges = acc.closed;
  const denom = rejects + merges;
  const reject: RejectStats = { rejects, merges, rate: denom > 0 ? rejects / denom : null };
  return {
    id: acc.id,
    label: acc.label,
    throughput: { total: acc.closed, series: acc.series },
    cycle: acc.cycle.length > 0 ? cycleStats(acc.cycle) : null,
    reject,
  };
}

/** Busiest (highest throughput) first; ties broken by label for stable order. */
function byBusiest(a: GroupMetrics, b: GroupMetrics): number {
  return b.throughput.total - a.throughput.total || a.label.localeCompare(b.label);
}

/**
 * Derive the full metrics model for a window from normalized events. Events
 * outside `(nowMs - window, nowMs]` are ignored, so the same event list can be
 * re-derived for any window without re-fetching.
 */
export function deriveMetrics(events: readonly MetricEvent[], opts: DeriveOptions): MetricsModel {
  const { window, nowMs } = opts;
  const windowMs = window.hours * MS_PER_HOUR;
  const startMs = nowMs - windowMs;
  const bucketMs = windowMs / window.buckets;

  const overall = newAcc('overall', 'All rigs', window.buckets);
  const rigs = new Map<string, Acc>();
  const agents = new Map<string, Acc>();

  const bucketIndex = (tsMs: number): number => {
    const i = Math.floor((tsMs - startMs) / bucketMs);
    return Math.min(window.buckets - 1, Math.max(0, i));
  };

  for (const ev of events) {
    if (ev.tsMs <= startMs || ev.tsMs > nowMs) continue;

    let rig = rigs.get(ev.rig);
    if (!rig) {
      rig = newAcc(ev.rig, ev.rig, window.buckets);
      rigs.set(ev.rig, rig);
    }
    let agent = agents.get(ev.agent);
    if (!agent) {
      agent = newAcc(ev.agent, ev.agent, window.buckets);
      agents.set(ev.agent, agent);
    }
    const targets = [overall, rig, agent];

    if (ev.kind === 'closed') {
      const bucket = bucketIndex(ev.tsMs);
      const hasCycle = ev.createdAtMs !== null && ev.createdAtMs <= ev.tsMs;
      const duration = hasCycle ? ev.tsMs - (ev.createdAtMs as number) : 0;
      for (const t of targets) {
        t.closed += 1;
        t.series[bucket] += 1;
        if (hasCycle) t.cycle.push(duration);
      }
    } else {
      const key = `${ev.beadId} ${ev.rejectionReason ?? ''}`;
      for (const t of targets) t.rejectKeys.add(key);
    }
  }

  return {
    window,
    nowMs,
    overall: toGroup(overall),
    byRig: [...rigs.values()].map(toGroup).sort(byBusiest),
    byAgent: [...agents.values()].map(toGroup).sort(byBusiest),
  };
}
