import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  GhostexParseError,
  isRecord,
  parseBoardItems,
  parseHealth,
  parseJson,
  parseLifecycleResult,
  parsePresentationSession,
  parsePresentationSnapshot,
  parseProject,
  parseProjectList,
  parseServerHealth,
  parseSession,
  parseSessionList,
  parseSessionText,
  parseTypedOperationResult,
} from './parse.ts';

const session = {
  sessionId: 'G0abc',
  projectId: 'P0xyz',
  globalRef: 'S0a:P0xyz:G0abc',
  kind: 'agent',
  title: 'claude',
  lifecycleState: 'running',
  surface: 'workspace',
  agentId: 'claude',
  cwd: '/repo',
  isFavorite: true,
  isPinned: false,
  createdAt: '2026-06-12T00:00:00Z',
  updatedAt: '2026-06-12T00:01:00Z',
  lastActiveAt: '2026-06-12T00:02:00Z',
};

test('isRecord narrows plain objects only', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord('x'), false);
});

test('parseJson throws GhostexParseError on bad JSON', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.throws(() => parseJson('{nope'), GhostexParseError);
});

test('parseSession projects the full domain shape', () => {
  const s = parseSession(session);
  assert.equal(s.sessionId, 'G0abc');
  assert.equal(s.projectId, 'P0xyz');
  assert.equal(s.kind, 'agent');
  assert.equal(s.agentId, 'claude');
  assert.equal(s.cwd, '/repo');
  assert.equal(s.isFavorite, true);
  assert.equal(s.lastActiveAt, '2026-06-12T00:02:00Z');
});

test('parseSession derives globalRef and defaults when fields are absent', () => {
  const s = parseSession({ sessionId: 'G1', projectId: 'P1' });
  assert.equal(s.globalRef, 'P1:G1');
  assert.equal(s.kind, 'terminal'); // unknown kind => terminal
  assert.equal(s.lifecycleState, 'unknown');
  assert.equal(s.surface, 'workspace');
  assert.equal(s.title, '');
  assert.equal(s.isFavorite, false);
  assert.equal(s.agentId, undefined);
  assert.equal(s.cwd, undefined);
});

test('parseSession coerces unknown enum values to safe defaults', () => {
  const s = parseSession({ sessionId: 'G1', projectId: 'P1', kind: 'weird', lifecycleState: 'nope', surface: 'huh' });
  assert.equal(s.kind, 'terminal');
  assert.equal(s.lifecycleState, 'unknown');
  assert.equal(s.surface, 'workspace');
});

test('parseSession rejects non-objects and missing required ids', () => {
  assert.throws(() => parseSession(null), /expected object/);
  assert.throws(() => parseSession([]), /expected object/);
  assert.throws(() => parseSession({ projectId: 'P1' }), /sessionId/);
  assert.throws(() => parseSession({ sessionId: 'G1' }), /projectId/);
});

test('parseSessionList accepts a bare array and a wrapped object', () => {
  assert.equal(parseSessionList([session]).length, 1);
  assert.equal(parseSessionList({ sessions: [session, session] }).length, 2);
  assert.throws(() => parseSessionList({ nope: [] }), /array/);
  assert.throws(() => parseSessionList(42), /array/);
});

test('parseProject and parseProjectList project identity fields', () => {
  const p = parseProject({ projectId: 'P0xyz', name: 'refinery', path: '/r', isPinned: true });
  assert.equal(p.projectId, 'P0xyz');
  assert.equal(p.name, 'refinery');
  assert.equal(p.path, '/r');
  assert.equal(p.isPinned, true);
  assert.equal(parseProjectList({ projects: [{ projectId: 'P1', name: 'a' }] }).length, 1);
  assert.throws(() => parseProject({ name: 'no-id' }), /projectId/);
});

test('parseLifecycleResult unwraps { session }', () => {
  const r = parseLifecycleResult({ session });
  assert.equal(r.session.sessionId, 'G0abc');
  assert.throws(() => parseLifecycleResult('x'), /expected object/);
});

test('parseSessionText reads string, text, or stdout', () => {
  assert.equal(parseSessionText('raw output'), 'raw output');
  assert.equal(parseSessionText({ text: 'from text' }), 'from text');
  assert.equal(parseSessionText({ stdout: 'from stdout' }), 'from stdout');
  assert.equal(parseSessionText({}), '');
  assert.throws(() => parseSessionText(42), /expected object or string/);
});

test('parsePresentationSession projects activity and defaults', () => {
  const ps = parsePresentationSession({
    sessionId: 'G0abc',
    projectId: 'P0xyz',
    groupId: 'grp',
    title: 't',
    kind: 'agent',
    activity: 'working',
    lifecycleState: 'running',
    surface: 'workspace',
    sortKey: 'k',
  });
  assert.equal(ps.activity, 'working');
  assert.equal(ps.groupId, 'grp');
  const fallback = parsePresentationSession({ sessionId: 'G1', projectId: 'P1' });
  assert.equal(fallback.activity, 'idle'); // unknown activity => idle
  assert.throws(() => parsePresentationSession(null), /expected object/);
});

test('parsePresentationSnapshot reads a bare snapshot and a wrapped one', () => {
  const snap = {
    revision: 7,
    generatedAt: '2026-06-12T00:00:00Z',
    projects: [{ projectId: 'P1', title: 'a', sortKey: 'k' }],
    groups: [{ groupId: 'g1', projectId: 'P1', title: 'grp', sessionIds: ['G1', 2, 'G2'], sortKey: 'k' }],
    sessions: [{ sessionId: 'G1', projectId: 'P1' }],
  };
  const direct = parsePresentationSnapshot(snap);
  assert.equal(direct.revision, 7);
  assert.equal(direct.projects.length, 1);
  assert.equal(direct.groups[0].sessionIds.length, 2); // the numeric id is dropped
  assert.equal(direct.sessions.length, 1);

  const wrapped = parsePresentationSnapshot({ snapshot: snap });
  assert.equal(wrapped.revision, 7);

  const empty = parsePresentationSnapshot({});
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.projects, []);
  assert.throws(() => parsePresentationSnapshot(null), /expected object/);
});

test('parseTypedOperationResult projects op fields and worktrees', () => {
  const r = parseTypedOperationResult({
    action: 'status',
    exitCode: 0,
    stdout: 'clean',
    stderr: '',
    worktrees: [{ path: '/wt', branch: 'main', bare: false, detached: false }],
  });
  assert.equal(r.action, 'status');
  assert.equal(r.exitCode, 0);
  assert.equal(r.worktrees?.length, 1);
  assert.equal(r.worktrees?.[0].path, '/wt');

  const noWt = parseTypedOperationResult({ action: 'commit', exitCode: 1, stdout: '', stderr: 'oops' });
  assert.equal(noWt.worktrees, undefined);
  assert.equal(noWt.exitCode, 1);
  assert.throws(() => parseTypedOperationResult('x'), /expected object/);
});

test('parseBoardItems reads issues from either shape', () => {
  const items = parseBoardItems({
    issues: [
      { id: 'bd-1', title: 'fix', status: 'open', priority: '1' },
      { issueId: 'bd-2', title: 'feat' },
      'not-an-object',
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'bd-1');
  assert.equal(items[0].status, 'open');
  assert.equal(items[1].id, 'bd-2'); // falls back to issueId
  assert.equal(items[1].status, undefined);
  assert.deepEqual(parseBoardItems([{ id: 'x', title: 'y' }]).length, 1);
});

test('parseTypedOperationResult rejects a non-object worktree entry', () => {
  assert.throws(
    () => parseTypedOperationResult({ action: 'list', exitCode: 0, stdout: '', stderr: '', worktrees: ['x'] }),
    /worktree entry: expected object/,
  );
});

test('parseBoardItems throws when there are no issues in any shape', () => {
  assert.throws(() => parseBoardItems(42), /array/);
  // worktree entries with non-string fields fall back to defaults
  const r = parseTypedOperationResult({
    action: 'list',
    exitCode: 0,
    stdout: '',
    stderr: '',
    worktrees: [{}],
  });
  assert.equal(r.worktrees?.[0].path, '');
  assert.equal(r.worktrees?.[0].bare, false);
});

test('parseServerHealth rejects a non-object body via parseHealth', () => {
  assert.throws(() => parseServerHealth(null), /expected object/);
  // missing detailed fields default rather than throw
  const sh = parseServerHealth({ ok: true, product: 'gxserver', protocolVersion: 1, version: 'x' });
  assert.equal(sh.serverId, '');
  assert.equal(sh.pid, 0);
  assert.deepEqual(sh.capabilities, []);
});

test('parseHealth and parseServerHealth project the gxserver health bodies', () => {
  const h = parseHealth({ ok: true, product: 'gxserver', protocolVersion: 1, version: '1.2.3' });
  assert.equal(h.ok, true);
  assert.equal(h.product, 'gxserver');
  assert.equal(h.protocolVersion, 1);
  assert.equal(h.version, '1.2.3');

  const sh = parseServerHealth({
    ok: true,
    product: 'gxserver',
    protocolVersion: 1,
    version: '1.2.3',
    serverId: 'S0a',
    buildIdentity: 'build-xyz',
    pid: 4242,
    port: 58744,
    startedAt: '2026-06-12T00:00:00Z',
    capabilities: ['sessions', 42, 'projects'],
  });
  assert.equal(sh.serverId, 'S0a');
  assert.equal(sh.pid, 4242);
  assert.deepEqual(sh.capabilities, ['sessions', 'projects']); // non-strings filtered

  assert.throws(() => parseHealth(null), /expected object/);
  // defaults when fields are absent
  const bare = parseHealth({});
  assert.equal(bare.ok, false);
  assert.equal(bare.version, 'unknown');
});

test('the structured parsers reject non-object inputs', () => {
  assert.throws(() => parseProject(null), /project: expected object/);
  // a non-record element inside the snapshot's projects/groups arrays propagates.
  assert.throws(() => parsePresentationSnapshot({ projects: [42] }), /presentation project: expected object/);
  assert.throws(() => parsePresentationSnapshot({ groups: [42] }), /presentation group: expected object/);
});

test('parsePresentationSnapshot defaults a group sessionIds to [] when not an array', () => {
  const snap = parsePresentationSnapshot({
    groups: [{ groupId: 'G0', projectId: 'P0', sessionIds: 'not-an-array' }],
  });
  assert.equal(snap.groups.length, 1);
  assert.deepEqual(snap.groups[0].sessionIds, []);
});
