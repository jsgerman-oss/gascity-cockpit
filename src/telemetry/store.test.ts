import { describe, expect, it } from 'vitest';
import { TelemetryStore } from './store';
import type { WorkerOperation } from './types';

const op = (over: Partial<WorkerOperation> = {}): WorkerOperation => ({
  seq: 1,
  ts: 't1',
  city: 'c',
  agent: 'A',
  bead: 'b1',
  model: 'm1',
  provider: 'claude',
  operation: 'session.submit',
  result: 'success',
  ok: true,
  durationMs: 100,
  opId: 'o1',
  ...over,
});

describe('TelemetryStore', () => {
  it('rolls up operations per agent and per bead with a per-model breakdown', () => {
    const store = new TelemetryStore();
    store.addOperation(op({ seq: 1, agent: 'A', bead: 'b1', model: 'm1' }));
    store.addOperation(op({ seq: 2, agent: 'A', bead: 'b2', model: 'm2' }));

    const { agents, beads, totals } = store.state;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.key).toBe('A');
    expect(agents[0]!.operations).toBe(2);
    expect(agents[0]!.models.map((m) => m.model).sort()).toEqual(['m1', 'm2']);
    expect(beads.map((b) => b.key).sort()).toEqual(['b1', 'b2']);
    expect(totals.operations).toBe(2);
    expect(totals.agents).toBe(1);
    expect(totals.beads).toBe(2);
  });

  it('dedupes operations replayed after a reconnect by seq', () => {
    const store = new TelemetryStore();
    store.addOperation(op({ seq: 5 }));
    store.addOperation(op({ seq: 5 })); // exact replay
    store.addOperation(op({ seq: 3 })); // older than the watermark
    expect(store.state.totals.operations).toBe(1);
    store.addOperation(op({ seq: 6 }));
    expect(store.state.totals.operations).toBe(2);
  });

  it('distinguishes unmeasured tokens from a measured zero', () => {
    const store = new TelemetryStore();
    store.addOperation(op({ seq: 1 })); // no token fields — the current /v0 reality
    expect(store.state.anyCostMeasured).toBe(false);
    expect(store.state.totals.tokens.measuredOps).toBe(0);

    store.addOperation(op({ seq: 2, promptTokens: 0 })); // measured, and it is zero
    expect(store.state.anyCostMeasured).toBe(true);
    expect(store.state.totals.tokens.measuredOps).toBe(1);
    expect(store.state.totals.tokens.promptIn).toBe(0);
  });

  it('sums tokens and cost across operations on the same scope and model', () => {
    const store = new TelemetryStore();
    store.addOperation(op({ seq: 1, promptTokens: 100, completionTokens: 10, costUsd: 0.01 }));
    store.addOperation(op({ seq: 2, promptTokens: 200, completionTokens: 20, costUsd: 0.02 }));

    const agent = store.state.agents[0]!;
    expect(agent.tokens.promptIn).toBe(300);
    expect(agent.tokens.completionOut).toBe(30);
    expect(agent.tokens.measuredOps).toBe(2);
    expect(agent.costUsd).toBeCloseTo(0.03, 6);
    expect(agent.costMeasuredOps).toBe(2);
    expect(agent.models[0]!.tokens.promptIn).toBe(300);
    expect(store.state.totals.costUsd).toBeCloseTo(0.03, 6);
  });

  it('folds cache-creation and cache-read tokens into scope, model and totals', () => {
    const store = new TelemetryStore();
    store.addOperation(op({ seq: 1, cacheCreationTokens: 500, cacheReadTokens: 1200 }));

    const agent = store.state.agents[0]!;
    expect(agent.tokens.cacheCreation).toBe(500);
    expect(agent.tokens.cacheRead).toBe(1200);
    expect(agent.tokens.measuredOps).toBe(1);
    expect(agent.models[0]!.tokens.cacheCreation).toBe(500);
    expect(agent.models[0]!.tokens.cacheRead).toBe(1200);
    expect(store.state.totals.tokens.cacheCreation).toBe(500);
    expect(store.state.totals.tokens.cacheRead).toBe(1200);
    expect(store.state.anyCostMeasured).toBe(true);
  });

  it('counts successes and failures at scope, model and totals', () => {
    const store = new TelemetryStore();
    store.addOperation(op({ seq: 1, ok: true }));
    store.addOperation(op({ seq: 2, ok: false }));
    const agent = store.state.agents[0]!;
    expect([agent.succeeded, agent.failed]).toEqual([1, 1]);
    expect([agent.models[0]!.succeeded, agent.models[0]!.failed]).toEqual([1, 1]);
    expect([store.state.totals.succeeded, store.state.totals.failed]).toEqual([1, 1]);
  });

  it('merges providers per model, de-duplicated and sorted', () => {
    const store = new TelemetryStore();
    store.addOperation(op({ seq: 1, model: 'm1', provider: 'claude' }));
    store.addOperation(op({ seq: 2, model: 'm1', provider: 'openai' }));
    store.addOperation(op({ seq: 3, model: 'm1', provider: 'claude' }));
    expect(store.state.agents[0]!.models[0]!.providers).toEqual(['claude', 'openai']);
  });

  it('orders scopes by most-recent activity', () => {
    const store = new TelemetryStore();
    // Seqs are monotonic; the most-recently-touched scope sorts first.
    store.addOperation(op({ seq: 1, agent: 'A' }));
    store.addOperation(op({ seq: 2, agent: 'C' }));
    store.addOperation(op({ seq: 3, agent: 'B' }));
    expect(store.state.agents.map((a) => a.key)).toEqual(['B', 'C', 'A']);
  });

  it('evicts the coldest scope once the cap is exceeded', () => {
    const store = new TelemetryStore(2);
    store.addOperation(op({ seq: 1, agent: 'A' }));
    store.addOperation(op({ seq: 2, agent: 'B' }));
    store.addOperation(op({ seq: 3, agent: 'C' })); // exceeds cap → evict coldest (A)
    expect(store.state.agents.map((a) => a.key)).toEqual(['C', 'B']);
    expect(store.state.evicted).toBe(true);
    // Totals stay cumulative across everything ever observed.
    expect(store.state.totals.operations).toBe(3);
  });

  it('clear() zeroes the rollups but keeps dropping replays', () => {
    const store = new TelemetryStore();
    store.addOperation(op({ seq: 1 }));
    store.addOperation(op({ seq: 2 }));
    store.clear();
    expect(store.state.agents).toHaveLength(0);
    expect(store.state.totals.operations).toBe(0);

    store.addOperation(op({ seq: 2 })); // already-seen seq stays dropped
    expect(store.state.totals.operations).toBe(0);
    store.addOperation(op({ seq: 3 }));
    expect(store.state.totals.operations).toBe(1);
  });

  it('tracks the stream status and fires on change', () => {
    const store = new TelemetryStore();
    let fires = 0;
    store.onDidChange(() => (fires += 1));
    store.setStreamStatus({ state: 'open', detail: 'streaming', attempt: 0 });
    expect(store.state.stream?.state).toBe('open');
    expect(fires).toBe(1);
  });

  it('tracks supervisor connectivity and re-renders only on a real change', () => {
    const store = new TelemetryStore();
    expect(store.state.connectivity).toBe('starting');
    let fires = 0;
    store.onDidChange(() => (fires += 1));

    // No-op while it stays 'starting'.
    store.setConnectivity('starting');
    expect(fires).toBe(0);

    store.setConnectivity('lost');
    expect(store.state.connectivity).toBe('lost');
    expect(fires).toBe(1);

    // Idempotent: the same value does not re-fire.
    store.setConnectivity('lost');
    expect(fires).toBe(1);
  });

  it('dispose tears down the change emitter so listeners stop firing', () => {
    const store = new TelemetryStore();
    let fires = 0;
    store.onDidChange(() => (fires += 1));

    store.dispose();
    store.setStreamStatus({ state: 'open', detail: 'streaming', attempt: 0 });

    expect(fires).toBe(0);
  });
});
