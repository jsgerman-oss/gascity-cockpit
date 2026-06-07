// The observable model behind the metrics pane (cockpit-3x7).
//
// A plain, `vscode`-free state container (Seam 1), mirroring TelemetryStore: the
// feature pushes load outcomes in, the tree view subscribes to the single
// `onDidChange` signal and re-renders from `state`. It also owns the two view
// preferences the panes toggle — the reporting window and the group-by dimension
// — so a window change can be detected (and trigger a refetch) without the view
// holding its own copy.
import { Emitter } from '../discovery/index.ts';
import { DEFAULT_WINDOW_ID } from './derive.ts';
import type { MetricGroupBy, MetricWindowId, MetricsModel, MetricsState } from './types.ts';

export class MetricsStore {
  private readonly emitter = new Emitter<void>();
  /** Fires after any state change; the tree view re-renders from {@link state}. */
  readonly onDidChange = this.emitter.event;

  private _state: MetricsState = {
    phase: 'idle',
    windowId: DEFAULT_WINDOW_ID,
    groupBy: 'rig',
    model: null,
    partial: false,
    fetchedAtMs: null,
    errorDetail: null,
  };

  /** Current immutable-by-convention state snapshot. */
  get state(): MetricsState {
    return this._state;
  }

  private set(patch: Partial<MetricsState>): void {
    this._state = { ...this._state, ...patch };
    this.emitter.fire();
  }

  /** Enter the loading state (keeps the prior model visible until a result lands). */
  setLoading(): void {
    this.set({ phase: 'loading', errorDetail: null });
  }

  /** Record a derived model. `partial` flags a capped / partially-failed fetch. */
  setResult(model: MetricsModel, opts: { partial: boolean; fetchedAtMs: number }): void {
    this.set({
      phase: 'ready',
      model,
      partial: opts.partial,
      fetchedAtMs: opts.fetchedAtMs,
      errorDetail: null,
    });
  }

  /** Record a hard load failure (supervisor unreachable). */
  setError(detail: string): void {
    this.set({ phase: 'error', errorDetail: detail });
  }

  /** Select a reporting window. Returns true only when it actually changed. */
  setWindow(windowId: MetricWindowId): boolean {
    if (this._state.windowId === windowId) return false;
    this.set({ windowId });
    return true;
  }

  /** Flip the group-by dimension (rig ⇄ agent) and return the new value. */
  toggleGroupBy(): MetricGroupBy {
    const groupBy: MetricGroupBy = this._state.groupBy === 'rig' ? 'agent' : 'rig';
    this.set({ groupBy });
    return groupBy;
  }

  /** Reset to idle, dropping any model — used when the supervisor goes away. */
  clear(): void {
    this.set({ phase: 'idle', model: null, partial: false, fetchedAtMs: null, errorDetail: null });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
