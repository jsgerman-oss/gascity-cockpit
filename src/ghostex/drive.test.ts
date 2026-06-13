import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  GhostexDriveError,
  resolveSessionTarget,
  SessionDriver,
  type GxSessionApi,
} from './drive.ts';
import type { GhostexSession, GhostexSessionLifecycleResult } from './types.ts';

const SESSION: GhostexSession = {
  sessionId: 'G0abc',
  projectId: 'P0xyz',
  globalRef: 'S0a:P0xyz:G0abc',
  kind: 'agent',
  title: 'claude',
  lifecycleState: 'running',
  surface: 'workspace',
  isFavorite: false,
  isPinned: false,
  createdAt: '2026-06-12T00:00:00Z',
  updatedAt: '2026-06-12T00:00:00Z',
};

/** Records every call and returns a (configurable) session/lifecycle payload. */
class FakeSessionApi implements GxSessionApi {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  constructor(
    private readonly session: GhostexSession = SESSION,
    private readonly text = 'terminal output',
  ) {}
  private record(method: string, params: Record<string, unknown>): void {
    this.calls.push({ method, params });
  }
  private lifecycle(): GhostexSessionLifecycleResult {
    return { session: this.session };
  }
  createSession(params: { projectId: string; title?: string; cwd?: string }): Promise<GhostexSession> {
    this.record('createSession', params);
    return Promise.resolve(this.session);
  }
  createAgentSession(params: {
    projectId: string;
    agentId: string;
    title?: string;
    cwd?: string;
  }): Promise<GhostexSession> {
    this.record('createAgentSession', params);
    return Promise.resolve(this.session);
  }
  renameSession(params: { projectId: string; sessionId: string; title: string }): Promise<void> {
    this.record('renameSession', params);
    return Promise.resolve();
  }
  readSessionText(params: { sessionId: string; projectId?: string }): Promise<string> {
    this.record('readSessionText', params);
    return Promise.resolve(this.text);
  }
  sendSessionText(params: { sessionId: string; projectId?: string; text: string }): Promise<void> {
    this.record('sendSessionText', params);
    return Promise.resolve();
  }
  sendSessionMessage(params: {
    sessionId: string;
    projectId?: string;
    text: string;
    submit?: boolean;
  }): Promise<void> {
    this.record('sendSessionMessage', params);
    return Promise.resolve();
  }
  sleepSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult> {
    this.record('sleepSession', params);
    return Promise.resolve(this.lifecycle());
  }
  wakeSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult> {
    this.record('wakeSession', params);
    return Promise.resolve(this.lifecycle());
  }
  killSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult> {
    this.record('killSession', params);
    return Promise.resolve(this.lifecycle());
  }
  focusSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult> {
    this.record('focusSession', params);
    return Promise.resolve(this.lifecycle());
  }
}

const TARGET = { sessionId: 'G0abc', projectId: 'P0xyz' };

// ---- resolveSessionTarget --------------------------------------------------

test('resolveSessionTarget reads ids straight off the node', () => {
  assert.deepEqual(resolveSessionTarget({ sessionId: 'G1', projectId: 'P1', label: 'x' }), {
    sessionId: 'G1',
    projectId: 'P1',
  });
});

test('resolveSessionTarget reads ids from a nested .session and trims them', () => {
  assert.deepEqual(resolveSessionTarget({ session: { sessionId: ' G2 ', projectId: ' P2 ' } }), {
    sessionId: 'G2',
    projectId: 'P2',
  });
});

test('resolveSessionTarget returns null when there is no addressable session', () => {
  assert.equal(resolveSessionTarget(undefined), null);
  assert.equal(resolveSessionTarget(null), null);
  assert.equal(resolveSessionTarget('G1'), null);
  assert.equal(resolveSessionTarget(42), null);
  assert.equal(resolveSessionTarget({ sessionId: 'G1' }), null); // missing projectId
  assert.equal(resolveSessionTarget({ sessionId: '  ', projectId: 'P1' }), null); // blank id
  assert.equal(resolveSessionTarget({ session: { sessionId: 'G1' } }), null); // nested missing projectId
  assert.equal(resolveSessionTarget({ session: 'not-an-object' }), null);
});

// ---- create ----------------------------------------------------------------

test('createTerminalSession forwards trimmed title/cwd and drops blanks', async () => {
  const gx = new FakeSessionApi();
  const driver = new SessionDriver(gx);
  await driver.createTerminalSession({ projectId: ' P0xyz ', title: '  shell  ', cwd: '  /repo ' });
  assert.deepEqual(gx.calls[0], {
    method: 'createSession',
    params: { projectId: 'P0xyz', title: 'shell', cwd: '/repo' },
  });
  await driver.createTerminalSession({ projectId: 'P0xyz', title: '   ', cwd: '' });
  assert.deepEqual(gx.calls[1].params, { projectId: 'P0xyz', title: undefined, cwd: undefined });
});

test('createTerminalSession rejects a blank project id before any call', async () => {
  const gx = new FakeSessionApi();
  await assert.rejects(new SessionDriver(gx).createTerminalSession({ projectId: '  ' }), GhostexDriveError);
  assert.equal(gx.calls.length, 0);
});

test('createAgentSession does the two-phase rename when a title is requested', async () => {
  // The created session keeps its auto-generated title ("claude"); the requested
  // title differs, so phase 2 (rename) runs and the returned session reflects it.
  const gx = new FakeSessionApi();
  const created = await new SessionDriver(gx).createAgentSession({
    projectId: 'P0xyz',
    agentId: 'claude',
    title: 'Fix the bug',
    cwd: '/repo',
  });
  assert.deepEqual(gx.calls[0], {
    method: 'createAgentSession',
    params: { projectId: 'P0xyz', agentId: 'claude', cwd: '/repo' }, // title NOT passed to create
  });
  assert.deepEqual(gx.calls[1], {
    method: 'renameSession',
    params: { projectId: 'P0xyz', sessionId: 'G0abc', title: 'Fix the bug' },
  });
  assert.equal(created.title, 'Fix the bug');
});

test('createAgentSession skips the rename when no title is requested', async () => {
  const gx = new FakeSessionApi();
  const created = await new SessionDriver(gx).createAgentSession({ projectId: 'P0xyz', agentId: 'claude' });
  assert.deepEqual(
    gx.calls.map((c) => c.method),
    ['createAgentSession'],
  );
  assert.equal(created.title, 'claude');
});

test('createAgentSession skips the rename when the title already matches', async () => {
  const gx = new FakeSessionApi(); // created session title is "claude"
  await new SessionDriver(gx).createAgentSession({ projectId: 'P0xyz', agentId: 'claude', title: ' claude ' });
  assert.deepEqual(
    gx.calls.map((c) => c.method),
    ['createAgentSession'],
  );
});

test('createAgentSession validates project and agent ids', async () => {
  const gx = new FakeSessionApi();
  await assert.rejects(
    new SessionDriver(gx).createAgentSession({ projectId: 'P0xyz', agentId: '' }),
    GhostexDriveError,
  );
  await assert.rejects(
    new SessionDriver(gx).createAgentSession({ projectId: '', agentId: 'claude' }),
    GhostexDriveError,
  );
  assert.equal(gx.calls.length, 0);
});

// ---- rename ----------------------------------------------------------------

test('rename forwards a trimmed title to the rename endpoint', async () => {
  const gx = new FakeSessionApi();
  await new SessionDriver(gx).rename(TARGET, '  New title  ');
  assert.deepEqual(gx.calls[0], {
    method: 'renameSession',
    params: { projectId: 'P0xyz', sessionId: 'G0abc', title: 'New title' },
  });
});

test('rename rejects a blank title and a half-specified target', async () => {
  const gx = new FakeSessionApi();
  await assert.rejects(new SessionDriver(gx).rename(TARGET, '   '), GhostexDriveError);
  await assert.rejects(
    new SessionDriver(gx).rename({ sessionId: 'G0abc', projectId: '' }, 'New'),
    GhostexDriveError,
  );
});

// ---- lifecycle (focus / sleep / wake / kill) -------------------------------

test('lifecycle ops call the matching endpoint with the target and unwrap the session', async () => {
  const gx = new FakeSessionApi();
  const driver = new SessionDriver(gx);
  assert.equal((await driver.focus(TARGET)).sessionId, 'G0abc');
  assert.equal((await driver.sleep(TARGET)).sessionId, 'G0abc');
  assert.equal((await driver.wake(TARGET)).sessionId, 'G0abc');
  assert.equal((await driver.kill(TARGET)).sessionId, 'G0abc');
  assert.deepEqual(
    gx.calls.map((c) => c.method),
    ['focusSession', 'sleepSession', 'wakeSession', 'killSession'],
  );
  assert.deepEqual(gx.calls[0].params, { sessionId: 'G0abc', projectId: 'P0xyz' });
});

test('lifecycle ops reject a target missing its project id', async () => {
  const gx = new FakeSessionApi();
  await assert.rejects(new SessionDriver(gx).focus({ sessionId: 'G0abc', projectId: '' }), GhostexDriveError);
  assert.equal(gx.calls.length, 0);
});

// ---- send / read -----------------------------------------------------------

test('sendText stages the body verbatim (whitespace preserved) without submitting', async () => {
  const gx = new FakeSessionApi();
  await new SessionDriver(gx).sendText(TARGET, '  indented snippet\n');
  assert.deepEqual(gx.calls[0], {
    method: 'sendSessionText',
    params: { sessionId: 'G0abc', projectId: 'P0xyz', text: '  indented snippet\n' },
  });
});

test('sendMessage submits the body (submit=true)', async () => {
  const gx = new FakeSessionApi();
  await new SessionDriver(gx).sendMessage(TARGET, 'run the tests');
  assert.deepEqual(gx.calls[0], {
    method: 'sendSessionMessage',
    params: { sessionId: 'G0abc', projectId: 'P0xyz', text: 'run the tests', submit: true },
  });
});

test('sendText and sendMessage reject a blank body', async () => {
  const gx = new FakeSessionApi();
  await assert.rejects(new SessionDriver(gx).sendText(TARGET, '   '), GhostexDriveError);
  await assert.rejects(new SessionDriver(gx).sendMessage(TARGET, ''), GhostexDriveError);
  assert.equal(gx.calls.length, 0);
});

test('readText returns the session output', async () => {
  const gx = new FakeSessionApi(SESSION, 'hello from the agent');
  assert.equal(await new SessionDriver(gx).readText(TARGET), 'hello from the agent');
  assert.deepEqual(gx.calls[0].params, { sessionId: 'G0abc', projectId: 'P0xyz' });
});
