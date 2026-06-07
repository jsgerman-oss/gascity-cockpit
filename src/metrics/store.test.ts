import { describe, expect, it } from 'vitest';
import { deriveMetrics, windowById } from './derive.ts';
import { MetricsStore } from './store.ts';

function model() {
  return deriveMetrics([], { window: windowById('7d'), nowMs: 0 });
}

/** Count how often the store's change signal fires. */
function counter(store: MetricsStore): () => number {
  let n = 0;
  store.onDidChange(() => (n += 1));
  return () => n;
}

describe('MetricsStore', () => {
  it('starts idle with the default window and rig grouping', () => {
    const s = new MetricsStore();
    expect(s.state).toMatchObject({ phase: 'idle', windowId: '7d', groupBy: 'rig', model: null, partial: false });
  });

  it('moves through loading → ready, firing on each change', () => {
    const s = new MetricsStore();
    const fired = counter(s);

    s.setLoading();
    expect(s.state.phase).toBe('loading');

    s.setResult(model(), { partial: true, fetchedAtMs: 123 });
    expect(s.state).toMatchObject({ phase: 'ready', partial: true, fetchedAtMs: 123, errorDetail: null });
    expect(s.state.model).not.toBeNull();
    expect(fired()).toBe(2);
  });

  it('records an error detail', () => {
    const s = new MetricsStore();
    s.setError('supervisor unreachable');
    expect(s.state).toMatchObject({ phase: 'error', errorDetail: 'supervisor unreachable' });
  });

  it('only reports a window change when it actually changes', () => {
    const s = new MetricsStore();
    const fired = counter(s);
    expect(s.setWindow('7d')).toBe(false); // already 7d
    expect(fired()).toBe(0);
    expect(s.setWindow('24h')).toBe(true);
    expect(s.state.windowId).toBe('24h');
    expect(fired()).toBe(1);
  });

  it('toggles group-by between rig and agent', () => {
    const s = new MetricsStore();
    expect(s.toggleGroupBy()).toBe('agent');
    expect(s.state.groupBy).toBe('agent');
    expect(s.toggleGroupBy()).toBe('rig');
    expect(s.state.groupBy).toBe('rig');
  });

  it('clears back to idle, dropping the model', () => {
    const s = new MetricsStore();
    s.setResult(model(), { partial: false, fetchedAtMs: 1 });
    s.clear();
    expect(s.state).toMatchObject({ phase: 'idle', model: null, partial: false, fetchedAtMs: null });
  });

  it('stops firing after dispose detaches nothing further (sanity)', () => {
    const s = new MetricsStore();
    s.dispose();
    // After dispose the emitter is torn down; calling a mutator must not throw.
    expect(() => s.clear()).not.toThrow();
  });
});
