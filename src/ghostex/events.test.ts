import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  backoffDelay,
  eventsUrl,
  GhostexEventStream,
  parseGhostexEvent,
  type GhostexEvent,
  type WebSocketLike,
} from './events.ts';

const snapshotBody = {
  revision: 5,
  generatedAt: '2026-06-12T00:00:00Z',
  projects: [],
  groups: [],
  sessions: [],
};

const presentationSession = {
  sessionId: 'G0abc',
  projectId: 'P0xyz',
  groupId: 'grp',
  title: 't',
  kind: 'agent',
  activity: 'working',
  lifecycleState: 'running',
  surface: 'workspace',
  sortKey: 'k',
};

// ---- parseGhostexEvent -----------------------------------------------------

test('parseGhostexEvent reads lifecycle frames', () => {
  for (const type of ['eventStreamReady', 'serverStarted', 'serverStopping'] as const) {
    const ev = parseGhostexEvent({ type, serverId: 'S0a', protocolVersion: 1 });
    assert.equal(ev?.type, type);
    assert.equal(ev?.type === type ? ev.serverId : '', 'S0a');
  }
});

test('parseGhostexEvent reads a presentationSnapshot frame', () => {
  const ev = parseGhostexEvent({ type: 'presentationSnapshot', revision: 5, snapshot: snapshotBody });
  assert.equal(ev?.type, 'presentationSnapshot');
  if (ev?.type !== 'presentationSnapshot') return;
  assert.equal(ev.revision, 5);
  assert.equal(ev.snapshot.revision, 5);
});

test('parseGhostexEvent reads a session-upsert delta', () => {
  const ev = parseGhostexEvent({
    type: 'presentationDelta',
    revision: 6,
    delta: { type: 'sessionUpdated', session: presentationSession },
  });
  assert.equal(ev?.type, 'presentationDelta');
  if (ev?.type !== 'presentationDelta') return;
  assert.equal(ev.revision, 6);
  assert.equal(ev.delta.kind, 'sessionUpserted');
  if (ev.delta.kind !== 'sessionUpserted') return;
  assert.equal(ev.delta.session.sessionId, 'G0abc');
});

test('parseGhostexEvent reads sessionRemoved / projectRemoved / other deltas', () => {
  const removed = parseGhostexEvent({
    type: 'presentationDelta',
    revision: 7,
    delta: { type: 'sessionRemoved', projectId: 'P0xyz', sessionId: 'G0abc' },
  });
  assert.equal(removed?.type === 'presentationDelta' && removed.delta.kind, 'sessionRemoved');

  const projectRemoved = parseGhostexEvent({
    type: 'presentationDelta',
    revision: 8,
    delta: { type: 'projectRemoved', projectId: 'P0xyz' },
  });
  assert.equal(projectRemoved?.type === 'presentationDelta' && projectRemoved.delta.kind, 'projectRemoved');

  const other = parseGhostexEvent({
    type: 'presentationDelta',
    revision: 9,
    delta: { type: 'groupAdded', group: {} },
  });
  assert.equal(other?.type === 'presentationDelta' && other.delta.kind, 'other');
});

test('parseGhostexEvent ignores unknown, malformed, and non-acted frames', () => {
  assert.equal(parseGhostexEvent(null), null);
  assert.equal(parseGhostexEvent({ noType: true }), null);
  assert.equal(parseGhostexEvent({ type: 'apiRequestHandled' }), null);
  assert.equal(parseGhostexEvent({ type: 'rendererCommand', command: {} }), null);
  // a snapshot frame with a non-object snapshot is dropped
  assert.equal(parseGhostexEvent({ type: 'presentationSnapshot', snapshot: 'nope' }), null);
  // a delta with a malformed session is dropped
  assert.equal(
    parseGhostexEvent({ type: 'presentationDelta', delta: { type: 'sessionAdded', session: { noId: 1 } } }),
    null,
  );
  // a delta with no inner type is dropped
  assert.equal(parseGhostexEvent({ type: 'presentationDelta', delta: {} }), null);
  assert.equal(parseGhostexEvent({ type: 'presentationDelta', delta: 'x' }), null);
});

// ---- eventsUrl + backoffDelay ----------------------------------------------

test('eventsUrl converts http(s) to ws(s) and threads protocol + token', () => {
  assert.equal(
    eventsUrl('http://127.0.0.1:58744'),
    'ws://127.0.0.1:58744/api/events?protocolVersion=1',
  );
  assert.equal(
    eventsUrl('https://host:9000/', 'tok'),
    'wss://host:9000/api/events?protocolVersion=1&token=tok',
  );
});

test('backoffDelay grows exponentially and caps at maxDelayMs', () => {
  const opts = { baseDelayMs: 500, maxDelayMs: 15_000, jitterFactor: 0 };
  assert.equal(backoffDelay(1, opts, () => 0.5), 500);
  assert.equal(backoffDelay(2, opts, () => 0.5), 1000);
  assert.equal(backoffDelay(3, opts, () => 0.5), 2000);
  assert.equal(backoffDelay(10, opts, () => 0.5), 15_000); // capped
  // jitter at the extremes stays within ±factor
  const jittered = backoffDelay(2, { ...opts, jitterFactor: 0.2 }, () => 0);
  assert.equal(jittered, 800); // 1000 * (1 - 0.2)
});

// ---- GhostexEventStream lifecycle ------------------------------------------

/** A controllable fake socket that records sends and exposes its handlers. */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** Test helpers. */
  emitOpen(): void {
    this.onopen?.();
  }
  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
  emitClose(): void {
    this.onclose?.({ code: 1006, reason: 'lost' });
  }
}

/** A manual timer queue so reconnect scheduling is deterministic. */
class FakeClock {
  private pending: { id: number; cb: () => void }[] = [];
  private nextId = 1;
  readonly setTimer = (cb: () => void): unknown => {
    const id = this.nextId++;
    this.pending.push({ id, cb });
    return id;
  };
  readonly clearTimer = (handle: unknown): void => {
    this.pending = this.pending.filter((t) => t.id !== handle);
  };
  /** Run all currently-queued timers (FIFO). */
  flush(): void {
    const due = this.pending;
    this.pending = [];
    for (const t of due) t.cb();
  }
  get count(): number {
    return this.pending.length;
  }
}

function makeStream(overrides: {
  sockets: FakeSocket[];
  clock: FakeClock;
  onEvent: (e: GhostexEvent) => void;
}): GhostexEventStream {
  let i = 0;
  return new GhostexEventStream({
    baseUrl: 'http://127.0.0.1:58744',
    token: 'tok',
    createWebSocket: () => {
      const s = overrides.sockets[i++];
      if (!s) throw new Error('no more fake sockets');
      return s;
    },
    onEvent: overrides.onEvent,
    setTimer: overrides.clock.setTimer,
    clearTimer: overrides.clock.clearTimer,
    random: () => 0.5,
  });
}

test('GhostexEventStream subscribes on open and forwards parsed events', () => {
  const socket = new FakeSocket();
  const clock = new FakeClock();
  const events: GhostexEvent[] = [];
  const stream = makeStream({ sockets: [socket], clock, onEvent: (e) => events.push(e) });

  stream.start();
  assert.equal(stream.connectionState, 'connecting');
  socket.emitOpen();
  assert.equal(stream.connectionState, 'open');
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'subscribePresentation', protocolVersion: 1 });

  socket.emitMessage(JSON.stringify({ type: 'presentationSnapshot', revision: 5, snapshot: snapshotBody }));
  socket.emitMessage(JSON.stringify({ type: 'apiRequestHandled' })); // ignored
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'presentationSnapshot');

  stream.stop();
  assert.equal(socket.closed, true);
  assert.equal(stream.connectionState, 'closed');
});

test('GhostexEventStream reconnects on close and resubscribes from lastRevision', () => {
  const first = new FakeSocket();
  const second = new FakeSocket();
  const clock = new FakeClock();
  const events: GhostexEvent[] = [];
  const stream = makeStream({ sockets: [first, second], clock, onEvent: (e) => events.push(e) });

  stream.start();
  first.emitOpen();
  // advance the revision so the resubscribe carries lastRevision
  first.emitMessage(JSON.stringify({ type: 'presentationDelta', revision: 12, delta: { type: 'sessionAdded', session: presentationSession } }));
  assert.equal(events.length, 1);

  // socket drops -> a reconnect is scheduled
  first.emitClose();
  assert.equal(stream.connectionState, 'reconnecting');
  assert.equal(clock.count, 1);

  // fire the backoff timer -> second socket opens and resubscribes with lastRevision
  clock.flush();
  second.emitOpen();
  assert.equal(stream.connectionState, 'open');
  assert.equal(second.sent.length, 1);
  assert.deepEqual(JSON.parse(second.sent[0]), {
    type: 'subscribePresentation',
    protocolVersion: 1,
    lastRevision: 12,
  });

  stream.stop();
});

test('GhostexEventStream stop() cancels a pending reconnect and ignores stale callbacks', () => {
  const socket = new FakeSocket();
  const clock = new FakeClock();
  const stream = makeStream({ sockets: [socket], clock, onEvent: () => {} });

  stream.start();
  socket.emitOpen();
  socket.emitClose(); // schedules a reconnect
  assert.equal(clock.count, 1);

  stream.stop();
  assert.equal(clock.count, 0); // the pending reconnect timer was cleared

  // a late message from the (now-detached) socket must not throw or re-open
  socket.emitMessage(JSON.stringify({ type: 'serverStarted', serverId: 'S0a' }));
  assert.equal(stream.connectionState, 'closed');
});

test('GhostexEventStream ignores non-JSON frames without crashing', () => {
  const socket = new FakeSocket();
  const clock = new FakeClock();
  const events: GhostexEvent[] = [];
  const stream = makeStream({ sockets: [socket], clock, onEvent: (e) => events.push(e) });
  stream.start();
  socket.emitOpen();
  socket.emitMessage('not json');
  socket.emitMessage(new TextEncoder().encode(JSON.stringify({ type: 'serverStarted', serverId: 'S0a' })));
  assert.equal(events.length, 1); // the binary frame was decoded + parsed
  assert.equal(events[0].type, 'serverStarted');
  stream.stop();
});

test('GhostexEventStream reconnects when socket construction throws', () => {
  const clock = new FakeClock();
  let attempts = 0;
  const stream = new GhostexEventStream({
    baseUrl: 'http://127.0.0.1:58744',
    createWebSocket: () => {
      attempts++;
      throw new Error('cannot connect');
    },
    onEvent: () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  });
  stream.start();
  assert.equal(attempts, 1);
  assert.equal(stream.connectionState, 'reconnecting');
  assert.equal(clock.count, 1);
  stream.stop();
});

test('GhostexEventStream tolerates a send failure on subscribe and an onerror event', () => {
  const socket = new FakeSocket();
  socket.send = () => {
    throw new Error('socket not writable');
  };
  const clock = new FakeClock();
  const logs: string[] = [];
  const stream = new GhostexEventStream({
    baseUrl: 'http://127.0.0.1:58744',
    createWebSocket: () => socket,
    onEvent: () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (_level, message) => logs.push(message),
  });
  stream.start();
  socket.emitOpen(); // subscribe send throws but is caught
  socket.onerror?.({ message: 'boom' }); // error handler logs, does not throw
  assert.ok(logs.some((m) => m.includes('subscribe send failed')));
  assert.ok(logs.some((m) => m.includes('socket error')));
  assert.equal(stream.connectionState, 'open');
  stream.stop();
});

test('GhostexEventStream decodes ArrayBuffer frames and ignores non-coercible ones', () => {
  const socket = new FakeSocket();
  const clock = new FakeClock();
  const events: GhostexEvent[] = [];
  const stream = makeStream({ sockets: [socket], clock, onEvent: (e) => events.push(e) });
  stream.start();
  socket.emitOpen();
  // ArrayBuffer frame
  socket.emitMessage(new TextEncoder().encode(JSON.stringify({ type: 'serverStopping', serverId: 'S0a' })).buffer);
  // a frame that cannot be coerced to text is silently ignored
  socket.emitMessage({ some: 'object' });
  socket.emitMessage(123);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'serverStopping');
  stream.stop();
});

test('GhostexEventStream tolerates close() throwing during teardown', () => {
  const socket = new FakeSocket();
  socket.close = () => {
    throw new Error('already closed');
  };
  const clock = new FakeClock();
  const stream = makeStream({ sockets: [socket], clock, onEvent: () => {} });
  stream.start();
  socket.emitOpen();
  stream.stop(); // close() throws but is swallowed
  assert.equal(stream.connectionState, 'closed');
});

test('GhostexEventStream.start is idempotent and stop on idle is a no-op', () => {
  const socket = new FakeSocket();
  const clock = new FakeClock();
  let created = 0;
  const stream = new GhostexEventStream({
    baseUrl: 'http://127.0.0.1:58744',
    createWebSocket: () => {
      created++;
      return socket;
    },
    onEvent: () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  stream.start();
  stream.start(); // second start ignored while running
  assert.equal(created, 1);
  stream.dispose();
  // stop again on an already-stopped stream is harmless
  stream.stop();
  assert.equal(stream.connectionState, 'closed');
});
