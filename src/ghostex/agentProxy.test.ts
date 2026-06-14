import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  GhostexSessionProxy,
  PROXY_RESET_DIVIDER,
  paneAppend,
  renderTranscript,
  type GhostexProxyClient,
  type ProxiedSessionSnapshot,
  type ProxySourceSubscribe,
  type ProxyState,
  type ProxyTurn,
} from './agentProxy.ts';
import type { GhostexSession } from './types.ts';

// ---- helpers ---------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let all pending microtasks (the proxy's chained awaits) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeSession(sessionId: string, projectId = 'P1'): GhostexSession {
  return {
    sessionId,
    projectId,
    globalRef: `S0a:${projectId}:${sessionId}`,
    kind: 'terminal',
    title: 'proxy pane',
    lifecycleState: 'running',
    surface: 'workspace',
    isFavorite: false,
    isPinned: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function turn(role: string, text: string): ProxyTurn {
  return { role, text };
}

interface HarnessOptions {
  createImpl?: (params: { projectId: string; title?: string }) => Promise<GhostexSession>;
  sendImpl?: (params: { sessionId: string; text: string }) => Promise<void>;
  focusImpl?: () => Promise<{ session: GhostexSession }>;
  title?: string;
  closePaneOnDispose?: boolean;
}

/** A scripted Ghostex proxy client + a capturable source subscription. */
function harness(opts: HarnessOptions = {}) {
  const creates: { projectId: string; title?: string }[] = [];
  const sends: { sessionId: string; text: string }[] = [];
  const focuses: { sessionId: string; projectId?: string }[] = [];
  const kills: { sessionId: string; projectId?: string }[] = [];

  const gx: GhostexProxyClient = {
    createSession: (params) => {
      creates.push(params);
      return opts.createImpl ? opts.createImpl(params) : Promise.resolve(makeSession('PANE1', params.projectId));
    },
    sendSessionText: (params) => {
      sends.push(params);
      return opts.sendImpl ? opts.sendImpl(params) : Promise.resolve();
    },
    focusSession: (params) => {
      focuses.push(params);
      return opts.focusImpl ? opts.focusImpl() : Promise.resolve({ session: makeSession('PANE1') });
    },
    killSession: (params) => {
      kills.push(params);
      return Promise.resolve({ session: makeSession('PANE1') });
    },
  };

  let captured: ((s: ProxiedSessionSnapshot) => void) | null = null;
  let subscribeDisposed = false;
  const subscribe: ProxySourceSubscribe = (onSnapshot) => {
    captured = onSnapshot;
    return {
      dispose: () => {
        subscribeDisposed = true;
      },
    };
  };

  const proxy = new GhostexSessionProxy({
    gx,
    projectId: 'P1',
    source: { cityName: 'blackrim-hq', sessionId: 'sess-7' },
    subscribe,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.closePaneOnDispose !== undefined ? { closePaneOnDispose: opts.closePaneOnDispose } : {}),
  });

  return {
    proxy,
    creates,
    sends,
    focuses,
    kills,
    emit: (s: ProxiedSessionSnapshot): void => captured?.(s),
    get connected(): boolean {
      return captured !== null;
    },
    get subscribeDisposed(): boolean {
      return subscribeDisposed;
    },
  };
}

/** Collect every state the proxy emits. */
function record(proxy: GhostexSessionProxy): ProxyState[] {
  const states: ProxyState[] = [];
  proxy.onDidChange((s) => states.push(s));
  return states;
}

// ---- renderTranscript ------------------------------------------------------

test('renderTranscript returns empty string for no turns', () => {
  assert.equal(renderTranscript([]), '');
});

test('renderTranscript labels each turn and separates with a blank line', () => {
  assert.equal(
    renderTranscript([turn('user', 'hi'), turn('assistant', 'hello there')]),
    '[user]\nhi\n\n[assistant]\nhello there',
  );
});

test('renderTranscript omits whitespace-only turns and trims trailing space', () => {
  assert.equal(renderTranscript([turn('user', 'hi'), turn('assistant', '   \n ')]), '[user]\nhi');
  assert.equal(renderTranscript([turn('assistant', 'done   ')]), '[assistant]\ndone');
});

// ---- paneAppend ------------------------------------------------------------

test('paneAppend writes nothing when nothing changed', () => {
  assert.deepEqual(paneAppend('abc', 'abc'), { text: '', reset: false });
});

test('paneAppend writes nothing when next is empty', () => {
  assert.deepEqual(paneAppend('abc', ''), { text: '', reset: false });
});

test('paneAppend writes the whole transcript from an empty pane', () => {
  assert.deepEqual(paneAppend('', 'hello'), { text: 'hello', reset: false });
});

test('paneAppend appends only the new suffix when next extends previous', () => {
  assert.deepEqual(paneAppend('hello', 'hello world'), { text: ' world', reset: false });
});

test('paneAppend re-renders behind a divider when the transcript diverges', () => {
  const write = paneAppend('[user]\nhi', '[user]\nHELLO');
  assert.equal(write.reset, true);
  assert.equal(write.text, `\n\n${PROXY_RESET_DIVIDER}\n\n[user]\nHELLO`);
});

// ---- GhostexSessionProxy: construction + start -----------------------------

test('constructor seeds idle state from the source ref and optional title', () => {
  const h = harness({ title: 'My Agent' });
  assert.deepEqual(h.proxy.state, {
    source: { cityName: 'blackrim-hq', sessionId: 'sess-7' },
    proxySessionId: null,
    title: 'My Agent',
    activity: 'unknown',
    connection: 'idle',
    mirroredChars: 0,
    lastError: null,
  });
});

test('start creates the proxy pane and connects the source', async () => {
  const h = harness();
  await h.proxy.start();
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0]?.projectId, 'P1');
  // Default title derives from the source ref.
  assert.equal(h.creates[0]?.title, 'gas-city: blackrim-hq/sess-7');
  assert.equal(h.proxy.state.proxySessionId, 'PANE1');
  assert.equal(h.proxy.state.connection, 'mirroring');
  assert.equal(h.connected, true);
});

test('start surfaces a pane-creation failure as an error and does not connect', async () => {
  const h = harness({ createImpl: () => Promise.reject(new Error('no project')) });
  await h.proxy.start();
  assert.equal(h.proxy.state.connection, 'error');
  assert.equal(h.proxy.state.lastError, 'no project');
  assert.equal(h.connected, false);
});

test('start aborts cleanly if disposed while the pane is being created', async () => {
  const gate = deferred<GhostexSession>();
  const h = harness({ createImpl: () => gate.promise });
  const starting = h.proxy.start();
  h.proxy.dispose();
  gate.resolve(makeSession('PANE1'));
  await starting;
  // Disposed mid-create: never advanced to mirroring, never connected the source.
  assert.notEqual(h.proxy.state.connection, 'mirroring');
  assert.equal(h.connected, false);
});

// ---- mirroring -------------------------------------------------------------

test('mirrors the rendered transcript into the pane and tracks mirroredChars', async () => {
  const h = harness();
  await h.proxy.start();
  h.emit({ turns: [turn('user', 'hi')], activity: 'in-turn', title: 'Agent One' });
  await flush();

  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0]?.sessionId, 'PANE1');
  assert.equal(h.sends[0]?.text, '[user]\nhi');
  assert.equal(h.proxy.state.activity, 'in-turn');
  assert.equal(h.proxy.state.title, 'Agent One');
  assert.equal(h.proxy.state.mirroredChars, '[user]\nhi'.length);
});

test('appends only the new suffix across successive snapshots', async () => {
  const h = harness();
  await h.proxy.start();
  h.emit({ turns: [turn('user', 'hi')] });
  await flush();
  h.emit({ turns: [turn('user', 'hi'), turn('assistant', 'hello')] });
  await flush();

  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[0]?.text, '[user]\nhi');
  assert.equal(h.sends[1]?.text, '\n\n[assistant]\nhello');
});

test('writes a divider when the transcript diverges instead of extending', async () => {
  const h = harness();
  await h.proxy.start();
  h.emit({ turns: [turn('user', 'hi')] });
  await flush();
  // The first turn's text changed (an edit) — not an extension of the prior render.
  h.emit({ turns: [turn('user', 'HELLO')] });
  await flush();

  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[1]?.text, `\n\n${PROXY_RESET_DIVIDER}\n\n[user]\nHELLO`);
});

test('an unchanged snapshot triggers no further pane write', async () => {
  const h = harness();
  await h.proxy.start();
  h.emit({ turns: [turn('user', 'hi')] });
  await flush();
  h.emit({ turns: [turn('user', 'hi')] });
  await flush();
  assert.equal(h.sends.length, 1);
});

test('keeps the first title and ignores later titles', async () => {
  const h = harness();
  await h.proxy.start();
  h.emit({ turns: [turn('user', 'a')], title: 'First' });
  await flush();
  h.emit({ turns: [turn('user', 'a'), turn('assistant', 'b')], title: 'Second' });
  await flush();
  assert.equal(h.proxy.state.title, 'First');
});

test('a snapshot with no activity or new title still mirrors its transcript', async () => {
  const h = harness({ title: 'Preset' });
  await h.proxy.start();
  // No activity, and a title is already set — the state patch is skipped, but the
  // transcript must still flow to the pane.
  h.emit({ turns: [turn('user', 'ping')] });
  await flush();
  assert.equal(h.sends.length, 1);
  assert.equal(h.proxy.state.title, 'Preset');
  assert.equal(h.proxy.state.activity, 'unknown');
});

test('coalesces a burst of snapshots to the latest while a send is in flight', async () => {
  const gate = deferred<void>();
  let firstSend = true;
  const h = harness({
    sendImpl: () => {
      if (firstSend) {
        firstSend = false;
        return gate.promise;
      }
      return Promise.resolve();
    },
  });
  await h.proxy.start();

  h.emit({ turns: [turn('user', 'hi')] }); // starts the (blocked) first send
  await flush();
  h.emit({ turns: [turn('user', 'hi'), turn('assistant', 'mid')] }); // queued
  h.emit({ turns: [turn('user', 'hi'), turn('assistant', 'final')] }); // supersedes
  await flush();
  assert.equal(h.sends.length, 1); // still blocked on the first send

  gate.resolve();
  await flush();
  // Only the latest queued snapshot is sent — the intermediate one is coalesced.
  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[1]?.text, '\n\n[assistant]\nfinal');
});

// ---- failure handling ------------------------------------------------------

test('a send failure is soft and re-sends the missing text on the next snapshot', async () => {
  let failNext = true;
  const h = harness({
    sendImpl: () => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('pane busy'));
      }
      return Promise.resolve();
    },
  });
  await h.proxy.start();

  h.emit({ turns: [turn('user', 'hi')] });
  await flush();
  assert.equal(h.proxy.state.connection, 'error');
  assert.equal(h.proxy.state.lastError, 'pane busy');

  // The next snapshot re-sends from the un-advanced baseline (full transcript).
  h.emit({ turns: [turn('user', 'hi'), turn('assistant', 'ok')] });
  await flush();
  const lastSend = h.sends.at(-1);
  assert.equal(lastSend?.text, '[user]\nhi\n\n[assistant]\nok');
  assert.equal(h.proxy.state.connection, 'mirroring');
  assert.equal(h.proxy.state.lastError, null);
});

// ---- ended -----------------------------------------------------------------

test('closes the link after the final transcript when the source ends', async () => {
  const h = harness();
  await h.proxy.start();
  h.emit({ turns: [turn('user', 'hi'), turn('assistant', 'bye')], ended: true });
  await flush();

  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0]?.text, '[user]\nhi\n\n[assistant]\nbye');
  assert.equal(h.proxy.state.connection, 'closed');
  assert.equal(h.subscribeDisposed, true);
});

// ---- reveal (attach) -------------------------------------------------------

test('reveal focuses the pane, creating it first when not started', async () => {
  const h = harness();
  const ok = await h.proxy.reveal();
  assert.equal(ok, true);
  assert.equal(h.creates.length, 1);
  assert.equal(h.focuses.length, 1);
  assert.equal(h.focuses[0]?.sessionId, 'PANE1');
  assert.equal(h.focuses[0]?.projectId, 'P1');
});

test('reveal reuses the existing pane after start (one createSession total)', async () => {
  const h = harness();
  await h.proxy.start();
  const ok = await h.proxy.reveal();
  assert.equal(ok, true);
  assert.equal(h.creates.length, 1);
  assert.equal(h.focuses.length, 1);
});

test('reveal returns false and records the error when focus fails', async () => {
  const h = harness({ focusImpl: () => Promise.reject(new Error('no window')) });
  await h.proxy.start();
  const ok = await h.proxy.reveal();
  assert.equal(ok, false);
  assert.equal(h.proxy.state.lastError, 'no window');
});

// ---- pane creation: memoization + retry ------------------------------------

test('concurrent start + reveal share a single pane creation', async () => {
  const gate = deferred<GhostexSession>();
  const h = harness({ createImpl: () => gate.promise });
  const starting = h.proxy.start();
  const revealing = h.proxy.reveal();
  gate.resolve(makeSession('PANE1'));
  await Promise.all([starting, revealing]);
  assert.equal(h.creates.length, 1); // memoized — not created twice
  assert.equal(h.focuses.length, 1);
});

test('a failed pane creation is retried from scratch on the next call', async () => {
  let attempt = 0;
  const h = harness({
    createImpl: () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(makeSession('PANE2'));
    },
  });
  await h.proxy.start(); // first create fails
  assert.equal(h.proxy.state.connection, 'error');

  const ok = await h.proxy.reveal(); // second create succeeds
  assert.equal(ok, true);
  assert.equal(h.creates.length, 2);
  assert.equal(h.proxy.state.proxySessionId, 'PANE2');
});

// ---- dispose ---------------------------------------------------------------

test('dispose stops the source and, by default, leaves the pane open', async () => {
  const h = harness();
  await h.proxy.start();
  h.proxy.dispose();
  assert.equal(h.subscribeDisposed, true);
  assert.equal(h.kills.length, 0);
});

test('dispose kills the pane when closePaneOnDispose is set', async () => {
  const h = harness({ closePaneOnDispose: true });
  await h.proxy.start();
  h.proxy.dispose();
  assert.equal(h.kills.length, 1);
  assert.equal(h.kills[0]?.sessionId, 'PANE1');
});

test('dispose before a pane exists kills nothing even when closePaneOnDispose is set', () => {
  const h = harness({ closePaneOnDispose: true });
  h.proxy.dispose();
  assert.equal(h.kills.length, 0);
});

test('dispose is idempotent and silences later snapshots and patches', async () => {
  const h = harness();
  await h.proxy.start();
  const states = record(h.proxy);
  h.proxy.dispose();
  h.proxy.dispose(); // no-op second time
  h.emit({ turns: [turn('user', 'late')] }); // ignored after dispose
  await flush();
  assert.equal(states.length, 0);
  assert.equal(h.sends.length, 0);
});
