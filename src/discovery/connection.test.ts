import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, ConnectionManager, type ConnectionDeps } from './connection.ts';
import type { ApiEndpoint, ConnectionState, ConnectionStatus, HealthResponse } from './types.ts';
import type { DiscoveryResult } from './discovery.ts';

// ---- fixtures --------------------------------------------------------------

const ENDPOINT: ApiEndpoint = { baseUrl: 'http://127.0.0.1:8372', token: null, mode: 'supervisor', source: 'default' };

function health(over: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: 'ok',
    version: 'dev',
    build_id: 'B1',
    uptime_sec: 1,
    cities_total: 1,
    cities_running: 1,
    startup: { ready: true, phase: 'running', phases_completed: [] },
    ...over,
  };
}

const DISCOVER_OK: DiscoveryResult = { ok: true, endpoint: ENDPOINT, attempts: [] };
const DISCOVER_FAIL: DiscoveryResult = {
  ok: false,
  endpoint: null,
  attempts: [{ source: 'default', target: ENDPOINT.baseUrl, ok: false, reason: 'refused' }],
};

/** Single-slot virtual scheduler matching the manager's one-timer-at-a-time use. */
class FakeScheduler {
  now = 0;
  private seq = 0;
  private pending: { id: number; cb: () => void; dueAt: number } | null = null;

  readonly setTimer = (cb: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending = { id, cb, dueAt: this.now + ms };
    return id;
  };
  readonly clearTimer = (h: unknown): void => {
    if (this.pending && this.pending.id === h) this.pending = null;
  };
  readonly nowFn = (): number => this.now;

  get nextDelay(): number | null {
    return this.pending ? this.pending.dueAt - this.now : null;
  }

  /** Advance to the next scheduled timer, fire it, and let async work settle. */
  async runNext(): Promise<boolean> {
    if (!this.pending) return false;
    this.now = Math.max(this.now, this.pending.dueAt);
    const cb = this.pending.cb;
    this.pending = null;
    cb();
    await settle();
    return true;
  }
}

/** Flush pending microtasks (injected discover/probe resolve on the microtask queue). */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

interface Harness {
  mgr: ConnectionManager;
  sched: FakeScheduler;
  states: ConnectionState[];
  statuses: ConnectionStatus[];
  discoverCalls: () => number;
  probeCalls: () => number;
  setDiscover: (fn: () => Promise<DiscoveryResult>) => void;
  setProbe: (fn: (ep: ApiEndpoint) => Promise<HealthResponse>) => void;
}

function harness(initial?: { discover?: () => Promise<DiscoveryResult>; probe?: (ep: ApiEndpoint) => Promise<HealthResponse> }): Harness {
  const sched = new FakeScheduler();
  let discoverCount = 0;
  let probeCount = 0;
  let discoverFn = initial?.discover ?? (async () => DISCOVER_OK);
  let probeFn = initial?.probe ?? (async () => health());

  const deps: ConnectionDeps = {
    discover: () => {
      discoverCount++;
      return discoverFn();
    },
    probe: (ep) => {
      probeCount++;
      return probeFn(ep);
    },
    now: sched.nowFn,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    random: () => 0.5, // jitter => 0, deterministic delays
    options: { pollIntervalMs: 10_000, degradedPollMs: 1_000, baseDelayMs: 500, maxDelayMs: 15_000, jitterFactor: 0.2, unavailableAfterAttempts: 4 },
  };
  const mgr = new ConnectionManager(deps);
  const states: ConnectionState[] = [];
  const statuses: ConnectionStatus[] = [];
  mgr.onDidChangeStatus((s) => {
    states.push(s.state);
    statuses.push(s);
  });
  return {
    mgr,
    sched,
    states,
    statuses,
    discoverCalls: () => discoverCount,
    probeCalls: () => probeCount,
    setDiscover: (fn) => {
      discoverFn = fn;
    },
    setProbe: (fn) => {
      probeFn = fn;
    },
  };
}

// ---- backoff (pure) --------------------------------------------------------

test('backoffDelay grows exponentially and caps', () => {
  const opts = { baseDelayMs: 500, maxDelayMs: 15_000, jitterFactor: 0 };
  const half = () => 0.5; // no jitter
  assert.equal(backoffDelay(1, opts, half), 500);
  assert.equal(backoffDelay(2, opts, half), 1000);
  assert.equal(backoffDelay(3, opts, half), 2000);
  assert.equal(backoffDelay(10, opts, half), 15_000); // capped
});

test('backoffDelay applies bounded jitter', () => {
  const opts = { baseDelayMs: 1000, maxDelayMs: 15_000, jitterFactor: 0.2 };
  assert.equal(backoffDelay(1, opts, () => 0), 800); // -20%
  assert.equal(backoffDelay(1, opts, () => 1), 1200); // +20%
});

// ---- state machine ---------------------------------------------------------

test('start -> discovering -> connecting -> connected', async () => {
  const h = harness();
  h.mgr.start();
  await h.sched.runNext(); // fire the 0ms tick
  assert.deepEqual(h.states, ['discovering', 'connecting', 'connected']);
  assert.equal(h.mgr.status.state, 'connected');
  assert.equal(h.mgr.status.endpoint?.baseUrl, ENDPOINT.baseUrl);
  assert.equal(h.mgr.status.restarted, false);
  assert.equal(h.sched.nextDelay, 10_000); // poll scheduled
});

test('degraded while starting, then connected', async () => {
  const h = harness({ probe: async () => health({ startup: { ready: false, phase: 'starting_agents', phases_completed: [] } }) });
  h.mgr.start();
  await h.sched.runNext();
  assert.equal(h.mgr.status.state, 'degraded');
  assert.equal(h.sched.nextDelay, 1_000); // fast degraded poll
  h.setProbe(async () => health()); // now ready
  await h.sched.runNext();
  assert.equal(h.mgr.status.state, 'connected');
});

test('connection loss -> reconnecting -> re-discovers -> reconnects', async () => {
  const h = harness();
  h.mgr.start();
  await h.sched.runNext(); // connected
  assert.equal(h.mgr.status.state, 'connected');
  const discoversAfterConnect = h.discoverCalls();

  // API goes away.
  h.setProbe(async () => {
    throw new Error('ECONNREFUSED');
  });
  await h.sched.runNext(); // poll fires, probe fails
  assert.equal(h.mgr.status.state, 'reconnecting');
  assert.equal(h.mgr.status.endpoint, null); // endpoint dropped to force re-discovery
  assert.equal(h.sched.nextDelay, 500); // backoff attempt 1

  // API comes back; backoff tick re-runs discovery.
  h.setProbe(async () => health());
  await h.sched.runNext();
  assert.equal(h.mgr.status.state, 'connected');
  assert.ok(h.discoverCalls() > discoversAfterConnect, 're-discovery happened on reconnect');
});

test('backoff grows across failures and surfaces unavailable', async () => {
  const h = harness({ probe: async () => {
    throw new Error('refused');
  } });
  h.mgr.start();
  await h.sched.runNext(); // attempt 1 fails
  assert.equal(h.mgr.status.state, 'reconnecting');
  assert.equal(h.mgr.status.failedAttempts, 1);
  assert.equal(h.sched.nextDelay, 500);

  await h.sched.runNext(); // attempt 2
  assert.equal(h.sched.nextDelay, 1000);
  await h.sched.runNext(); // attempt 3
  assert.equal(h.sched.nextDelay, 2000);
  await h.sched.runNext(); // attempt 4 -> unavailable
  assert.equal(h.mgr.status.state, 'unavailable');
  assert.equal(h.mgr.status.failedAttempts, 4);
  assert.equal(h.sched.nextDelay, 4000); // still retrying
});

test('discovery failure also drives reconnect/unavailable', async () => {
  const h = harness({ discover: async () => DISCOVER_FAIL });
  h.mgr.start();
  await h.sched.runNext();
  assert.equal(h.mgr.status.state, 'reconnecting');
  assert.match(h.mgr.status.detail, /no reachable API endpoint/);
});

test('restart detected via build_id change sets restarted once', async () => {
  const h = harness();
  h.mgr.start();
  await h.sched.runNext(); // connected with B1
  assert.equal(h.mgr.status.restarted, false);

  h.setProbe(async () => health({ build_id: 'B2' })); // server rebuilt
  await h.sched.runNext(); // poll sees new build
  const connectedStatuses = h.statuses.filter((s) => s.state === 'connected');
  assert.equal(connectedStatuses.at(-1)?.restarted, true);

  // Subsequent stable poll: restarted flag clears.
  await h.sched.runNext();
  assert.equal(h.statuses.filter((s) => s.state === 'connected').at(-1)?.restarted, false);
});

test('stop() halts the machine and cancels timers', async () => {
  const h = harness();
  h.mgr.start();
  await h.sched.runNext(); // connected
  h.mgr.stop();
  assert.equal(h.mgr.status.state, 'idle');
  assert.equal(h.sched.nextDelay, null);
  assert.equal(h.mgr.status.endpoint, null);
});

test('reconnect() forces immediate re-discovery', async () => {
  const h = harness();
  h.mgr.start();
  await h.sched.runNext(); // connected
  const before = h.discoverCalls();
  h.mgr.reconnect();
  assert.equal(h.sched.nextDelay, 0); // scheduled immediately
  await h.sched.runNext();
  assert.ok(h.discoverCalls() > before);
  assert.equal(h.mgr.status.state, 'connected');
});

test('generation guard: a probe resolving after stop() does not change state', async () => {
  let releaseDiscover: (() => void) | null = null;
  const gated = new Promise<void>((r) => {
    releaseDiscover = r;
  });
  const h = harness({
    discover: async () => {
      await gated; // hang inside discovery
      return DISCOVER_OK;
    },
  });
  h.mgr.start();
  await h.sched.runNext(); // enters discovering, awaits gate
  assert.equal(h.mgr.status.state, 'discovering');
  h.mgr.stop();
  assert.equal(h.mgr.status.state, 'idle');
  releaseDiscover!(); // late discovery resolves
  await settle();
  assert.equal(h.mgr.status.state, 'idle'); // stale callback was ignored
});
