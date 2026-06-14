/**
 * Coverage for the chat ⇄ Ghostex-agent-session bridge core
 * (`chatBridge.ts`). The store is driven with a fake {@link GhostexChatClient},
 * a manual events dispatch, and an injected fake poll timer — no `vscode`, no
 * `gx` binary, no live gxserver — so submit→sendMessage, the event/poll→readText
 * stream, the state machine, the chat-view projection, and the target picker are
 * all exercised deterministically.
 */
import { describe, expect, it } from 'vitest';
import {
  GhostexChatStore,
  ghostexChatPickLabel,
  rankGhostexSessionsForChat,
  toChatActivity,
  toGhostexChatViewState,
  type GhostexChatClient,
  type GhostexChatState,
  type GhostexEventSubscribe,
} from './chatBridge.ts';
import type { GhostexEvent } from './events.ts';
import type {
  GhostexPresentationSession,
  GhostexSession,
  GhostexSessionActivity,
} from './types.ts';

const SID = 'G1';

/** A controllable fake of the narrow gxserver surface the store drives. */
class FakeClient implements GhostexChatClient {
  text = '';
  readCalls = 0;
  readError: Error | null = null;
  sendError: Error | null = null;
  readonly sent: { sessionId: string; text: string }[] = [];
  /** When set, readSessionText returns this pending promise (caller resolves it). */
  pendingRead: Promise<string> | null = null;

  async readSessionText(_params: { sessionId: string }): Promise<string> {
    this.readCalls += 1;
    if (this.pendingRead) return this.pendingRead;
    if (this.readError) throw this.readError;
    return this.text;
  }

  async sendSessionMessage(params: { sessionId: string; text: string }): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push(params);
  }
}

/** A captured fake poll timer: `fire()` runs the scheduled callback, like a clock tick. */
function fakeTimer(): {
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  fire: () => void;
  scheduledMs: number | null;
  cleared: number;
} {
  let cb: (() => void) | null = null;
  const state = { scheduledMs: null as number | null, cleared: 0 };
  return {
    setTimer: (fn, ms) => {
      cb = fn;
      state.scheduledMs = ms;
      return 1;
    },
    clearTimer: () => {
      state.cleared += 1;
      cb = null;
    },
    fire: () => {
      const fn = cb;
      cb = null;
      fn?.();
    },
    get scheduledMs() {
      return state.scheduledMs;
    },
    get cleared() {
      return state.cleared;
    },
  };
}

/** Flush pending microtasks + the macrotask queue (real timer, not the injected one). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function presentationSession(over: Partial<GhostexPresentationSession> = {}): GhostexPresentationSession {
  return {
    sessionId: SID,
    projectId: 'P1',
    groupId: 'grp',
    title: 'Furiosa',
    kind: 'agent',
    activity: 'working',
    lifecycleState: 'running',
    surface: 'workspace',
    isFavorite: false,
    isPinned: false,
    sortKey: '0',
    createdAt: '2026-06-13T00:00:00Z',
    updatedAt: '2026-06-13T00:00:00Z',
    ...over,
  };
}

function session(over: Partial<GhostexSession> = {}): GhostexSession {
  return {
    sessionId: SID,
    projectId: 'P1',
    globalRef: 'S1:P1:G1',
    kind: 'agent',
    title: 'Furiosa',
    lifecycleState: 'running',
    surface: 'workspace',
    isFavorite: false,
    isPinned: false,
    createdAt: '2026-06-13T00:00:00Z',
    updatedAt: '2026-06-13T00:00:00Z',
    ...over,
  };
}

const upsert = (s: GhostexPresentationSession, revision = 2): GhostexEvent => ({
  type: 'presentationDelta',
  revision,
  delta: { kind: 'sessionUpserted', session: s },
});

const removed = (sessionId: string, projectId = 'P1', revision = 3): GhostexEvent => ({
  type: 'presentationDelta',
  revision,
  delta: { kind: 'sessionRemoved', projectId, sessionId },
});

/** Build a store wired to a fake client, manual events, and a fake poll timer. */
function makeStore(opts: {
  pollIntervalMs?: number;
  withSubscribe?: boolean;
  session?: { title?: string; agentId?: string; activity?: GhostexSessionActivity };
} = {}): {
  store: GhostexChatStore;
  client: FakeClient;
  states: GhostexChatState[];
  emit: (event: GhostexEvent) => void;
  timer: ReturnType<typeof fakeTimer>;
  unsubscribed: () => number;
} {
  const client = new FakeClient();
  const timer = fakeTimer();
  let listener: ((event: GhostexEvent) => void) | null = null;
  let unsubCount = 0;
  const subscribe: GhostexEventSubscribe = (l) => {
    listener = l;
    return () => {
      unsubCount += 1;
      listener = null;
    };
  };
  const store = new GhostexChatStore({
    client,
    sessionId: SID,
    pollIntervalMs: opts.pollIntervalMs ?? 1000,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    ...(opts.withSubscribe === false ? {} : { subscribe }),
    ...(opts.session ? { session: opts.session } : {}),
  });
  const states: GhostexChatState[] = [];
  store.onDidChange((s) => states.push(s));
  return {
    store,
    client,
    states,
    emit: (event) => listener?.(event),
    timer,
    unsubscribed: () => unsubCount,
  };
}

describe('GhostexChatStore — construction', () => {
  it('defaults to an idle, empty state', () => {
    const { store } = makeStore();
    expect(store.state).toMatchObject({
      sessionId: SID,
      title: null,
      agentId: null,
      text: '',
      activity: 'unknown',
      connection: 'idle',
      sending: false,
      lastError: null,
    });
  });

  it('seeds title / agent / activity from the picked session row', () => {
    const { store } = makeStore({ session: { title: 'War Rig', agentId: 'claude', activity: 'working' } });
    expect(store.state).toMatchObject({ title: 'War Rig', agentId: 'claude', activity: 'working' });
  });
});

describe('GhostexChatStore — load', () => {
  it('reads the transcript and lands idle', async () => {
    const { store, client } = makeStore();
    client.text = 'hello from the pane';
    await store.load();
    expect(store.state).toMatchObject({ text: 'hello from the pane', connection: 'idle', lastError: null });
    expect(client.readCalls).toBe(1);
  });

  it('surfaces a read failure as an error connection', async () => {
    const { store, client } = makeStore();
    client.readError = new Error('gxserver down');
    await store.load();
    expect(store.state).toMatchObject({ connection: 'error', lastError: 'gxserver down' });
  });

  it('does not patch when disposed mid-read', async () => {
    const { store, client, states } = makeStore();
    let resolve!: (v: string) => void;
    client.pendingRead = new Promise<string>((r) => (resolve = r));
    const p = store.load();
    const before = states.length;
    store.dispose();
    resolve('late');
    await p;
    // The post-dispose `text` patch is suppressed.
    expect(states.length).toBe(before);
    expect(store.state.text).toBe('');
  });
});

describe('GhostexChatStore — connect / live output', () => {
  it('subscribes, marks streaming, reads immediately, and schedules a poll', async () => {
    const { store, client, timer } = makeStore({ pollIntervalMs: 1234 });
    client.text = 'live';
    store.connect();
    expect(store.state.connection).toBe('streaming');
    await tick();
    expect(store.state.text).toBe('live');
    expect(client.readCalls).toBe(1); // the immediate read
    expect(timer.scheduledMs).toBe(1234);
  });
});

describe('GhostexChatStore — poll diffing', () => {
  it('reads on a tick, repainting only when the transcript changed', async () => {
    const { store, client, states, timer } = makeStore();
    client.text = 'a';
    store.connect();
    await tick();
    const baseline = states.length;
    expect(store.state.text).toBe('a');

    // Tick with identical text: a read happens, no repaint.
    client.text = 'a';
    timer.fire();
    await tick();
    expect(client.readCalls).toBe(2);
    expect(states.length).toBe(baseline);

    // Tick with new text: repaint.
    client.text = 'a — and more';
    timer.fire();
    await tick();
    expect(store.state.text).toBe('a — and more');
    expect(states.length).toBe(baseline + 1);
  });

  it('keeps polling tick after tick (reschedules itself)', async () => {
    const { store, client, timer } = makeStore({ pollIntervalMs: 500 });
    store.connect();
    await tick();
    expect(timer.scheduledMs).toBe(500);
    timer.fire();
    await tick();
    // A fresh timer was scheduled by the tick.
    expect(timer.scheduledMs).toBe(500);
    expect(client.readCalls).toBe(2);
  });

  it('runs poll-only with no events subscription', async () => {
    const { store, client, timer, unsubscribed } = makeStore({ withSubscribe: false });
    client.text = 'x';
    store.connect();
    await tick();
    expect(store.state.text).toBe('x');
    timer.fire();
    await tick();
    expect(client.readCalls).toBe(2);
    store.disconnect();
    expect(unsubscribed()).toBe(0); // nothing to unsubscribe
  });

  it('does not schedule a poll when the interval is zero', async () => {
    const { store, timer } = makeStore({ pollIntervalMs: 0 });
    store.connect();
    await tick();
    expect(timer.scheduledMs).toBeNull();
  });
});

describe('GhostexChatStore — events', () => {
  it('applies an upsert for this session: activity, title, agent, and a re-read', async () => {
    const { store, client, emit } = makeStore();
    client.text = 'fresh output';
    store.connect();
    await tick();
    client.text = 'fresh output + delta';
    emit(upsert(presentationSession({ activity: 'attention', title: 'New Title', agentId: 'codex' })));
    await tick();
    expect(store.state).toMatchObject({ activity: 'attention', title: 'New Title', agentId: 'codex', text: 'fresh output + delta' });
  });

  it('ignores an upsert for a different session', async () => {
    const { store, emit, states } = makeStore();
    store.connect();
    await tick();
    const before = states.length;
    emit(upsert(presentationSession({ sessionId: 'OTHER', activity: 'idle' })));
    await tick();
    expect(states.length).toBe(before);
  });

  it('marks the connection closed when this session is removed', async () => {
    const { store, emit } = makeStore();
    store.connect();
    await tick();
    emit(removed(SID));
    expect(store.state).toMatchObject({ connection: 'closed', activity: 'unknown' });
  });

  it('ignores removal of a different session', async () => {
    const { store, emit } = makeStore();
    store.connect();
    await tick();
    emit(removed('OTHER'));
    expect(store.state.connection).toBe('streaming');
  });

  it('finds this session in a presentation snapshot and re-reads', async () => {
    const { store, client, emit } = makeStore();
    store.connect();
    await tick();
    client.text = 'snap text';
    emit({
      type: 'presentationSnapshot',
      revision: 5,
      snapshot: {
        revision: 5,
        generatedAt: '2026-06-13T00:00:00Z',
        projects: [],
        groups: [],
        sessions: [presentationSession({ activity: 'idle' })],
      },
    });
    await tick();
    expect(store.state).toMatchObject({ activity: 'idle', text: 'snap text' });
  });

  it('still re-reads on a snapshot that does not include this session', async () => {
    const { store, client, emit } = makeStore();
    store.connect();
    await tick();
    const before = client.readCalls;
    emit({
      type: 'presentationSnapshot',
      revision: 6,
      snapshot: { revision: 6, generatedAt: '', projects: [], groups: [], sessions: [] },
    });
    await tick();
    expect(client.readCalls).toBe(before + 1);
  });

  it('ignores the shared stream lifecycle frames', async () => {
    const { store, emit, states } = makeStore();
    store.connect();
    await tick();
    const before = states.length;
    emit({ type: 'eventStreamReady', serverId: 's1' });
    emit({ type: 'serverStopping', serverId: 's1' });
    await tick();
    expect(states.length).toBe(before);
    expect(store.state.connection).toBe('streaming');
  });

  it('drops events after dispose', async () => {
    const { store, emit, states } = makeStore();
    store.connect();
    await tick();
    store.dispose();
    const before = states.length;
    emit(upsert(presentationSession({ activity: 'idle' })));
    await tick();
    expect(states.length).toBe(before);
  });

  it('only patches presentation fields that actually changed', async () => {
    const { store, emit } = makeStore({ session: { title: 'Furiosa', agentId: 'claude' } });
    store.connect();
    await tick();
    // Same title + agent, only activity differs.
    emit(upsert(presentationSession({ title: 'Furiosa', agentId: 'claude', activity: 'idle' })));
    await tick();
    expect(store.state).toMatchObject({ title: 'Furiosa', agentId: 'claude', activity: 'idle' });
    // An upsert with no title/agent leaves the prior values intact.
    const bare = presentationSession({ activity: 'working' });
    emit(upsert({ ...bare, title: '', agentId: undefined }));
    await tick();
    expect(store.state).toMatchObject({ title: 'Furiosa', agentId: 'claude', activity: 'working' });
  });
});

describe('GhostexChatStore — submit', () => {
  it('routes the message to sendSessionMessage and re-reads', async () => {
    const { store, client } = makeStore();
    client.text = 'echo: hi';
    const result = await store.submit('hi');
    expect(result).toEqual({ ok: true });
    expect(client.sent).toEqual([{ sessionId: SID, text: 'hi' }]);
    await tick();
    expect(store.state.text).toBe('echo: hi');
    expect(store.state.sending).toBe(false);
  });

  it('reports a send failure without throwing', async () => {
    const { store, client } = makeStore();
    client.sendError = new Error('pane is asleep');
    const result = await store.submit('hi');
    expect(result).toEqual({ ok: false, error: 'pane is asleep' });
    expect(store.state).toMatchObject({ sending: false, lastError: 'pane is asleep' });
  });

  it('toggles `sending` across the call', async () => {
    const { store, client, states } = makeStore();
    await store.submit('hi');
    expect(states.some((s) => s.sending === true)).toBe(true);
    expect(store.state.sending).toBe(false);
    expect(client.readCalls).toBe(1); // the post-send re-read
  });
});

describe('GhostexChatStore — lifecycle', () => {
  it('start() loads then connects', async () => {
    const { store, client, timer } = makeStore();
    client.text = 'booted';
    await store.start();
    expect(store.state).toMatchObject({ text: 'booted', connection: 'streaming' });
    expect(client.readCalls).toBe(2); // load + the connect re-read
    expect(timer.scheduledMs).not.toBeNull();
  });

  it('connect() tears down a prior subscription + timer first', async () => {
    const { store, timer, unsubscribed } = makeStore();
    store.connect();
    await tick();
    store.connect();
    expect(unsubscribed()).toBe(1); // the first subscription was dropped
    expect(timer.cleared).toBeGreaterThanOrEqual(1);
  });

  it('disconnect() stops the poll and unsubscribes', async () => {
    const { store, client, timer, unsubscribed } = makeStore();
    store.connect();
    await tick();
    store.disconnect();
    expect(unsubscribed()).toBe(1);
    expect(timer.cleared).toBeGreaterThanOrEqual(1);
    // A fired (stale) timer would be a no-op, but disconnect cleared it anyway.
    timer.fire();
    await tick();
    expect(client.readCalls).toBe(1); // only the immediate connect read
  });

  it('connect() after dispose is a no-op', () => {
    const { store } = makeStore();
    store.dispose();
    store.connect();
    expect(store.state.connection).toBe('idle');
  });

  it('dispose() is idempotent and silences further patches', async () => {
    const { store, states } = makeStore();
    store.dispose();
    store.dispose();
    const before = states.length;
    await store.submit('after dispose'); // patches are suppressed
    expect(states.length).toBe(before);
  });

  it('serializes reads: a poll tick during an in-flight read is skipped', async () => {
    const { store, client, timer } = makeStore();
    let resolve!: (v: string) => void;
    client.pendingRead = new Promise<string>((r) => (resolve = r));
    store.connect(); // immediate read starts and suspends (refreshing = true)
    expect(client.readCalls).toBe(1);
    timer.fire(); // poll tick → refresh is guarded out, no second read
    expect(client.readCalls).toBe(1);
    resolve('done');
    await tick();
  });

  it('drops a refresh result that resolves after dispose', async () => {
    const { store, client, states } = makeStore();
    let resolve!: (v: string) => void;
    client.pendingRead = new Promise<string>((r) => (resolve = r));
    store.connect(); // immediate read suspends
    const before = states.length;
    store.dispose();
    resolve('too late');
    await tick();
    expect(store.state.text).toBe('');
    expect(states.length).toBe(before);
  });

  it('uses real timers when none are injected (default poll path)', async () => {
    const client = new FakeClient();
    const store = new GhostexChatStore({ client, sessionId: SID });
    store.connect(); // schedules a real 1500ms timer (never fires in-test)
    await tick();
    expect(store.state.connection).toBe('streaming');
    store.dispose(); // clears the real timer via the default clearTimer
    expect(client.readCalls).toBe(1);
  });
});

describe('toChatActivity', () => {
  it('passes through known activities and folds the rest to unknown', () => {
    expect(toChatActivity('working')).toBe('working');
    expect(toChatActivity('attention')).toBe('attention');
    expect(toChatActivity('idle')).toBe('idle');
    expect(toChatActivity(undefined)).toBe('unknown');
  });
});

describe('toGhostexChatViewState', () => {
  it('projects a live transcript onto the chat view-model', () => {
    const view = toGhostexChatViewState({
      sessionId: SID,
      title: 'War Rig',
      agentId: 'claude',
      text: 'agent output',
      activity: 'working',
      connection: 'streaming',
      sending: true,
      lastError: null,
    });
    expect(view).toMatchObject({
      cityName: '',
      sessionId: SID,
      title: 'War Rig',
      provider: 'claude',
      connection: 'streaming',
      activity: 'in-turn',
      turns: [{ role: 'agent', text: 'agent output' }],
      pending: null,
      capabilities: { followUp: false, interruptNow: false },
      permissionMode: null,
      sending: true,
      error: null,
      notice: null,
    });
  });

  it('emits no turns for an empty transcript and falls back to the id for the title', () => {
    const view = toGhostexChatViewState({
      sessionId: SID,
      title: null,
      agentId: null,
      text: '',
      activity: 'idle',
      connection: 'idle',
      sending: false,
      lastError: 'boom',
    });
    expect(view.turns).toEqual([]);
    expect(view.title).toBe(SID);
    expect(view.provider).toBeNull();
    expect(view.activity).toBe('idle');
    expect(view.error).toBe('boom');
  });

  it('maps a non-working, non-idle activity to unknown', () => {
    const view = toGhostexChatViewState({
      sessionId: SID,
      title: null,
      agentId: null,
      text: 'x',
      activity: 'attention',
      connection: 'streaming',
      sending: false,
      lastError: null,
    });
    expect(view.activity).toBe('unknown');
  });
});

describe('rankGhostexSessionsForChat', () => {
  it('keeps only agent sessions and floats running ones first', () => {
    const ranked = rankGhostexSessionsForChat([
      session({ sessionId: 'term', kind: 'terminal', title: 'a-terminal' }),
      session({ sessionId: 'sleep', lifecycleState: 'sleeping', title: 'zzz' }),
      session({ sessionId: 'run', lifecycleState: 'running', title: 'mmm' }),
    ]);
    expect(ranked.map((s) => s.sessionId)).toEqual(['run', 'sleep']);
  });

  it('orders by title within the same lifecycle and sinks unknown/other lifecycles', () => {
    const ranked = rankGhostexSessionsForChat([
      session({ sessionId: 'b', lifecycleState: 'running', title: 'Bravo' }),
      session({ sessionId: 'a', lifecycleState: 'running', title: 'Alpha' }),
      session({ sessionId: 'u', lifecycleState: 'unknown', title: 'Uniform' }),
      session({ sessionId: 'm', lifecycleState: 'missing', title: 'Mike' }),
    ]);
    expect(ranked.map((s) => s.sessionId)).toEqual(['a', 'b', 'u', 'm']);
  });

  it('does not mutate the input array', () => {
    const input = [session({ sessionId: 'a' }), session({ sessionId: 'b', lifecycleState: 'sleeping' })];
    const copy = [...input];
    rankGhostexSessionsForChat(input);
    expect(input).toEqual(copy);
  });
});

describe('ghostexChatPickLabel', () => {
  it('labels an agent session for the QuickPick', () => {
    expect(ghostexChatPickLabel(session({ agentId: 'claude', title: 'Furiosa' }))).toEqual({
      id: SID,
      label: 'Furiosa',
      description: 'agent:claude · running',
      detail: 'S1:P1:G1',
    });
  });

  it('falls back to a bare "agent" label and the session id when fields are missing', () => {
    expect(ghostexChatPickLabel(session({ agentId: undefined, title: '' }))).toEqual({
      id: SID,
      label: SID,
      description: 'agent · running',
      detail: 'S1:P1:G1',
    });
  });
});
