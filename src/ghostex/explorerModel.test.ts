import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  computeSessionPresentation,
  GhostexExplorerModel,
  resolveGhostexNotice,
  sessionIcon,
  sessionKindLabel,
  type GhostexProjectNode,
  type GhostexSessionNode,
  type GhostexMessageNode,
} from './explorerModel.ts';
import type {
  GhostexLifecycleState,
  GhostexPresentationGroup,
  GhostexPresentationProject,
  GhostexPresentationSession,
  GhostexPresentationSnapshot,
  GhostexSessionActivity,
  GhostexSessionKind,
  GhostexSessionSurface,
} from './types.ts';

// ---- fixtures --------------------------------------------------------------

function makeSession(s: {
  sessionId: string;
  projectId: string;
  groupId?: string;
  title?: string;
  kind?: GhostexSessionKind;
  activity?: GhostexSessionActivity;
  lifecycleState?: GhostexLifecycleState;
  surface?: GhostexSessionSurface;
  agentId?: string;
  agentName?: string;
  cwd?: string;
  subtitle?: string;
  sortKey?: string;
}): GhostexPresentationSession {
  return {
    sessionId: s.sessionId,
    projectId: s.projectId,
    groupId: s.groupId ?? 'g1',
    title: s.title ?? s.sessionId,
    kind: s.kind ?? 'terminal',
    activity: s.activity ?? 'idle',
    lifecycleState: s.lifecycleState ?? 'running',
    surface: s.surface ?? 'workspace',
    ...(s.agentId ? { agentId: s.agentId } : {}),
    ...(s.agentName ? { agentName: s.agentName } : {}),
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(s.subtitle ? { subtitle: s.subtitle } : {}),
    isFavorite: false,
    isPinned: false,
    sortKey: s.sortKey ?? '0',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-06-12T00:00:00Z',
  };
}

function makeProject(p: {
  projectId: string;
  title?: string;
  path?: string;
  sortKey?: string;
}): GhostexPresentationProject {
  return {
    projectId: p.projectId,
    title: p.title ?? p.projectId,
    ...(p.path ? { path: p.path } : {}),
    isFavorite: false,
    isPinned: false,
    sortKey: p.sortKey ?? '0',
  };
}

function makeGroup(g: { groupId: string; projectId: string; sortKey?: string }): GhostexPresentationGroup {
  return { groupId: g.groupId, projectId: g.projectId, title: g.groupId, sessionIds: [], sortKey: g.sortKey ?? '0' };
}

function makeSnapshot(over: Partial<GhostexPresentationSnapshot>): GhostexPresentationSnapshot {
  return { revision: 1, generatedAt: '2026-06-12T00:00:00Z', projects: [], groups: [], sessions: [], ...over };
}

function projectNodes(model: GhostexExplorerModel): GhostexProjectNode[] {
  return model.roots().filter((n): n is GhostexProjectNode => n.kind === 'project');
}

function messageRows(model: GhostexExplorerModel): GhostexMessageNode[] {
  return model.roots().filter((n): n is GhostexMessageNode => n.kind === 'message');
}

// ---- sessionIcon -----------------------------------------------------------

test('sessionIcon: lifecycle dominates for sleeping/stopped/missing', () => {
  assert.deepEqual(sessionIcon(makeSession({ sessionId: 's', projectId: 'p', lifecycleState: 'sleeping', activity: 'working' })), {
    icon: 'debug-pause',
    color: 'disabledForeground',
  });
  assert.deepEqual(sessionIcon(makeSession({ sessionId: 's', projectId: 'p', lifecycleState: 'stopped', activity: 'attention' })), {
    icon: 'circle-slash',
    color: 'disabledForeground',
  });
  assert.deepEqual(sessionIcon(makeSession({ sessionId: 's', projectId: 'p', lifecycleState: 'missing' })), {
    icon: 'question',
    color: 'disabledForeground',
  });
});

test('sessionIcon: a live session shows its activity', () => {
  assert.deepEqual(sessionIcon(makeSession({ sessionId: 's', projectId: 'p', lifecycleState: 'running', activity: 'attention' })), {
    icon: 'bell-dot',
    color: 'list.warningForeground',
  });
  assert.deepEqual(sessionIcon(makeSession({ sessionId: 's', projectId: 'p', lifecycleState: 'running', activity: 'working' })), {
    icon: 'sync~spin',
    color: 'charts.blue',
  });
  // idle carries no colour
  assert.deepEqual(sessionIcon(makeSession({ sessionId: 's', projectId: 'p', lifecycleState: 'running', activity: 'idle' })), {
    icon: 'circle-outline',
  });
  // an unknown lifecycle is treated as live (shows activity)
  assert.deepEqual(sessionIcon(makeSession({ sessionId: 's', projectId: 'p', lifecycleState: 'unknown', activity: 'working' })), {
    icon: 'sync~spin',
    color: 'charts.blue',
  });
});

// ---- sessionKindLabel ------------------------------------------------------

test('sessionKindLabel: agent name wins, then id, then bare; terminal is terminal', () => {
  assert.equal(sessionKindLabel(makeSession({ sessionId: 's', projectId: 'p', kind: 'agent', agentName: 'Claude', agentId: 'claude' })), 'agent:Claude');
  assert.equal(sessionKindLabel(makeSession({ sessionId: 's', projectId: 'p', kind: 'agent', agentId: 'claude' })), 'agent:claude');
  assert.equal(sessionKindLabel(makeSession({ sessionId: 's', projectId: 'p', kind: 'agent' })), 'agent');
  assert.equal(sessionKindLabel(makeSession({ sessionId: 's', projectId: 'p', kind: 'terminal' })), 'terminal');
});

// ---- computeSessionPresentation --------------------------------------------

test('computeSessionPresentation: working agent', () => {
  const p = computeSessionPresentation(
    makeSession({
      sessionId: 'G0a',
      projectId: 'P0',
      kind: 'agent',
      agentName: 'Claude',
      activity: 'working',
      lifecycleState: 'running',
      title: 'build the thing',
      cwd: '/work/repo',
      subtitle: 'on it',
    }),
  );
  assert.equal(p.icon, 'sync~spin');
  assert.equal(p.iconColor, 'charts.blue');
  assert.equal(p.label, 'build the thing');
  assert.equal(p.description, 'agent:Claude · running');
  assert.equal(p.contextValue, 'ghostexSession.agent.running');
  assert.equal(p.accessibleLabel, 'build the thing, agent:Claude, working, running');
  // tooltip carries the operator-relevant facts
  assert.match(p.tooltip, /\*\*build the thing\*\*/);
  assert.match(p.tooltip, /agent:Claude · running · working/);
  assert.match(p.tooltip, /on it/);
  assert.match(p.tooltip, /`\/work\/repo`/);
  assert.match(p.tooltip, /surface: workspace · updated 2026-06-12T00:00:00Z/);
  assert.match(p.tooltip, /id: `G0a`/);
});

test('computeSessionPresentation: idle row carries no icon colour, falls back to id for label', () => {
  const p = computeSessionPresentation(makeSession({ sessionId: 'G9', projectId: 'P0', title: '', activity: 'idle' }));
  assert.equal(p.icon, 'circle-outline');
  assert.equal(p.iconColor, undefined);
  assert.equal(p.label, 'G9'); // empty title falls back to the id
  assert.equal(p.description, 'terminal · running');
  // no cwd / subtitle lines when absent
  assert.doesNotMatch(p.tooltip, /``/);
});

// ---- resolveGhostexNotice --------------------------------------------------

test('resolveGhostexNotice: reconnecting and unavailable always surface a row', () => {
  const recon = resolveGhostexNotice('reconnecting', { loaded: true, hasContent: true, detail: 'socket closed' });
  assert.equal(recon?.tone, 'reconnecting');
  assert.equal(recon?.label, 'Reconnecting to Ghostex…');
  assert.equal(recon?.detail, 'socket closed');

  const down = resolveGhostexNotice('unavailable', { loaded: true, hasContent: true, detail: 'gxserver not running' });
  assert.equal(down?.tone, 'error');
  assert.equal(down?.label, 'Ghostex unavailable');
  assert.equal(down?.icon, 'plug');
  assert.equal(down?.detail, 'gxserver not running');
});

test('resolveGhostexNotice: discovering shows a spinner only with no content', () => {
  assert.equal(resolveGhostexNotice('discovering', { loaded: false, hasContent: false })?.tone, 'loading');
  assert.equal(resolveGhostexNotice('discovering', { loaded: false, hasContent: false })?.label, 'Connecting to Ghostex…');
  assert.equal(resolveGhostexNotice('discovering', { loaded: false, hasContent: true }), null);
});

test('resolveGhostexNotice: connected defers to data', () => {
  assert.equal(resolveGhostexNotice('connected', { loaded: true, hasContent: true }), null);
  assert.equal(resolveGhostexNotice('connected', { loaded: false, hasContent: false })?.label, 'Loading Ghostex sessions…');
  const empty = resolveGhostexNotice('connected', { loaded: true, hasContent: false });
  assert.equal(empty?.tone, 'empty');
  assert.equal(empty?.label, 'No Ghostex sessions');
  assert.equal(empty?.icon, 'ghost');
});

// ---- model: seeding + tree shape -------------------------------------------

test('seed populates the tree, sets revision/loaded/connected, and clears prior detail', () => {
  const model = new GhostexExplorerModel();
  assert.equal(model.isLoaded, false);
  assert.equal(model.connState, 'discovering');
  model.setConnState('unavailable', 'boom');

  const changed = model.seed(
    makeSnapshot({
      revision: 7,
      projects: [makeProject({ projectId: 'P0', title: 'Repo', path: '/r' })],
      groups: [makeGroup({ groupId: 'g1', projectId: 'P0' })],
      sessions: [makeSession({ sessionId: 'G0', projectId: 'P0', groupId: 'g1' })],
    }),
  );
  assert.equal(changed, true);
  assert.equal(model.currentRevision, 7);
  assert.equal(model.isLoaded, true);
  assert.equal(model.connState, 'connected');

  const projects = projectNodes(model);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].title, 'Repo');
  assert.equal(projects[0].path, '/r');
  assert.equal(projects[0].sessionCount, 1);
  // detail was cleared by the successful seed → no reconnecting/unavailable row
  assert.equal(messageRows(model).length, 0);
});

test('project rollups count attention + running sessions', () => {
  const model = new GhostexExplorerModel();
  model.seed(
    makeSnapshot({
      projects: [makeProject({ projectId: 'P0' })],
      groups: [makeGroup({ groupId: 'g1', projectId: 'P0' })],
      sessions: [
        makeSession({ sessionId: 'a', projectId: 'P0', activity: 'attention', lifecycleState: 'running' }),
        makeSession({ sessionId: 'b', projectId: 'P0', activity: 'idle', lifecycleState: 'running' }),
        makeSession({ sessionId: 'c', projectId: 'P0', activity: 'working', lifecycleState: 'sleeping' }),
      ],
    }),
  );
  const [p] = projectNodes(model);
  assert.equal(p.sessionCount, 3);
  assert.equal(p.attentionCount, 1);
  assert.equal(p.runningCount, 2);
});

test('projects sort by sortKey then title; childrenOf returns sessions ordered by group then session sortKey', () => {
  const model = new GhostexExplorerModel();
  model.seed(
    makeSnapshot({
      projects: [
        makeProject({ projectId: 'B', title: 'Beta', sortKey: '2' }),
        makeProject({ projectId: 'A', title: 'Alpha', sortKey: '1' }),
      ],
      groups: [
        makeGroup({ groupId: 'g-late', projectId: 'A', sortKey: '9' }),
        makeGroup({ groupId: 'g-early', projectId: 'A', sortKey: '1' }),
      ],
      sessions: [
        makeSession({ sessionId: 's-in-late', projectId: 'A', groupId: 'g-late', sortKey: '0' }),
        makeSession({ sessionId: 's-in-early-2', projectId: 'A', groupId: 'g-early', sortKey: '2', title: 'zzz' }),
        makeSession({ sessionId: 's-in-early-1', projectId: 'A', groupId: 'g-early', sortKey: '1', title: 'aaa' }),
      ],
    }),
  );
  const projects = projectNodes(model);
  assert.deepEqual(projects.map((p) => p.projectId), ['A', 'B']);

  const sessions = model.childrenOf(projects[0]).filter((n): n is GhostexSessionNode => n.kind === 'session');
  // g-early (sortKey 1) before g-late (sortKey 9); within g-early, session sortKey 1 before 2
  assert.deepEqual(sessions.map((s) => s.session.sessionId), ['s-in-early-1', 's-in-early-2', 's-in-late']);
});

test('childrenOf is empty for non-project nodes, and an ungrouped session sinks last', () => {
  const model = new GhostexExplorerModel();
  model.seed(
    makeSnapshot({
      projects: [makeProject({ projectId: 'P0' })],
      groups: [makeGroup({ groupId: 'g1', projectId: 'P0', sortKey: '1' })],
      sessions: [
        makeSession({ sessionId: 'orphan', projectId: 'P0', groupId: 'no-such-group', sortKey: '0' }),
        makeSession({ sessionId: 'grouped', projectId: 'P0', groupId: 'g1', sortKey: '0' }),
      ],
    }),
  );
  const [p] = projectNodes(model);
  const sessions = model.childrenOf(p).filter((n): n is GhostexSessionNode => n.kind === 'session');
  assert.deepEqual(sessions.map((s) => s.session.sessionId), ['grouped', 'orphan']);
  // a session/message node has no children
  assert.deepEqual(model.childrenOf(sessions[0]), []);
});

// ---- model: applying events ------------------------------------------------

test('applyEvent: a presentationSnapshot event reseeds the whole model', () => {
  const model = new GhostexExplorerModel();
  model.seed(makeSnapshot({ revision: 1, projects: [makeProject({ projectId: 'OLD' })] }));
  const changed = model.applyEvent({
    type: 'presentationSnapshot',
    revision: 5,
    snapshot: makeSnapshot({ revision: 5, projects: [makeProject({ projectId: 'NEW' })] }),
  });
  assert.equal(changed, true);
  assert.equal(model.currentRevision, 5);
  assert.deepEqual(projectNodes(model).map((p) => p.projectId), ['NEW']);
});

test('applyEvent: sessionUpserted adds then updates a session and advances revision', () => {
  const model = new GhostexExplorerModel();
  model.seed(makeSnapshot({ revision: 1, projects: [makeProject({ projectId: 'P0' })], groups: [makeGroup({ groupId: 'g1', projectId: 'P0' })] }));

  const added = model.applyEvent({
    type: 'presentationDelta',
    revision: 2,
    delta: { kind: 'sessionUpserted', session: makeSession({ sessionId: 'G0', projectId: 'P0', activity: 'idle' }) },
  });
  assert.equal(added, true);
  assert.equal(model.currentRevision, 2);
  assert.equal(projectNodes(model)[0].sessionCount, 1);

  const updated = model.applyEvent({
    type: 'presentationDelta',
    revision: 3,
    delta: { kind: 'sessionUpserted', session: makeSession({ sessionId: 'G0', projectId: 'P0', activity: 'attention' }) },
  });
  assert.equal(updated, true);
  assert.equal(projectNodes(model)[0].attentionCount, 1);
  assert.equal(projectNodes(model)[0].sessionCount, 1); // still one — it was replaced, not duplicated
});

test('applyEvent: sessionRemoved removes a present session and is a no-op otherwise', () => {
  const model = new GhostexExplorerModel();
  model.seed(
    makeSnapshot({
      projects: [makeProject({ projectId: 'P0' })],
      sessions: [makeSession({ sessionId: 'G0', projectId: 'P0' })],
    }),
  );
  assert.equal(model.applyEvent({ type: 'presentationDelta', revision: 2, delta: { kind: 'sessionRemoved', projectId: 'P0', sessionId: 'G0' } }), true);
  assert.equal(projectNodes(model)[0].sessionCount, 0);
  // removing again changes nothing
  assert.equal(model.applyEvent({ type: 'presentationDelta', revision: 3, delta: { kind: 'sessionRemoved', projectId: 'P0', sessionId: 'G0' } }), false);
});

test('applyEvent: projectRemoved drops the project, its groups and its sessions', () => {
  const model = new GhostexExplorerModel();
  model.seed(
    makeSnapshot({
      projects: [makeProject({ projectId: 'P0' }), makeProject({ projectId: 'P1' })],
      groups: [makeGroup({ groupId: 'g0', projectId: 'P0' }), makeGroup({ groupId: 'g1', projectId: 'P1' })],
      sessions: [makeSession({ sessionId: 'a', projectId: 'P0', groupId: 'g0' }), makeSession({ sessionId: 'b', projectId: 'P1', groupId: 'g1' })],
    }),
  );
  assert.equal(model.applyEvent({ type: 'presentationDelta', revision: 2, delta: { kind: 'projectRemoved', projectId: 'P0' } }), true);
  const projects = projectNodes(model);
  assert.deepEqual(projects.map((p) => p.projectId), ['P1']);
  assert.equal(projects[0].sessionCount, 1); // P1's session survived
  // removing an unknown project changes nothing
  assert.equal(model.applyEvent({ type: 'presentationDelta', revision: 3, delta: { kind: 'projectRemoved', projectId: 'ZZZ' } }), false);
});

test('applyEvent: an "other" delta is a no-op but still advances the revision', () => {
  const model = new GhostexExplorerModel();
  model.seed(makeSnapshot({ revision: 1 }));
  assert.equal(model.applyEvent({ type: 'presentationDelta', revision: 4, delta: { kind: 'other', deltaType: 'projectAdded' } }), false);
  assert.equal(model.currentRevision, 4);
});

test('applyEvent: a stale (lower) revision does not roll the tracked revision back', () => {
  const model = new GhostexExplorerModel();
  model.seed(makeSnapshot({ revision: 10 }));
  model.applyEvent({ type: 'presentationDelta', revision: 3, delta: { kind: 'other', deltaType: 'x' } });
  assert.equal(model.currentRevision, 10);
});

test('applyEvent: server lifecycle frames move the connection state', () => {
  const model = new GhostexExplorerModel();
  // serverStopping degrades to reconnecting
  assert.equal(model.applyEvent({ type: 'serverStopping', serverId: 'S0' }), true);
  assert.equal(model.connState, 'reconnecting');
  // a ready/started frame recovers to connected (a change), then is idempotent
  assert.equal(model.applyEvent({ type: 'eventStreamReady', serverId: 'S0' }), true);
  assert.equal(model.connState, 'connected');
  assert.equal(model.applyEvent({ type: 'serverStarted', serverId: 'S0' }), false);
});

// ---- model: connection-state notices ---------------------------------------

test('roots: a fresh model shows the connecting spinner', () => {
  const model = new GhostexExplorerModel();
  const rows = messageRows(model);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Connecting to Ghostex…');
  assert.equal(rows[0].icon, 'loading~spin');
});

test('roots: connected with an empty snapshot shows the empty row', () => {
  const model = new GhostexExplorerModel();
  model.seed(makeSnapshot({ revision: 1 }));
  const rows = messageRows(model);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'No Ghostex sessions');
  assert.equal(rows[0].icon, 'ghost');
  assert.equal(rows[0].detail, 'No projects or sessions are open in Ghostex.');
});

test('roots: reconnecting banners OVER retained project rows, replaces when empty', () => {
  const model = new GhostexExplorerModel();
  model.seed(makeSnapshot({ projects: [makeProject({ projectId: 'P0' })] }));
  model.setConnState('reconnecting', 'socket closed');
  const roots = model.roots();
  assert.equal(roots[0].kind, 'message'); // banner first
  assert.equal((roots[0] as GhostexMessageNode).iconColor, 'list.warningForeground');
  assert.equal(roots[1].kind, 'project'); // stale rows kept under it
  assert.equal(projectNodes(model).length, 1);

  // with nothing to show, the notice stands in for the whole tree
  const empty = new GhostexExplorerModel();
  empty.setConnState('reconnecting');
  assert.deepEqual(empty.roots().map((n) => n.kind), ['message']);
});

test('roots: a hard unavailable replaces content', () => {
  const model = new GhostexExplorerModel();
  model.seed(makeSnapshot({ projects: [makeProject({ projectId: 'P0' })] }));
  model.setConnState('unavailable', 'gxserver not running');
  assert.deepEqual(model.roots().map((n) => n.kind), ['message']);
  assert.equal(messageRows(model)[0].label, 'Ghostex unavailable');
});

test('setConnState is idempotent on an unchanged transition', () => {
  const model = new GhostexExplorerModel();
  assert.equal(model.setConnState('reconnecting', 'x'), true);
  assert.equal(model.setConnState('reconnecting', 'x'), false);
  assert.equal(model.setConnState('reconnecting', 'y'), true); // detail changed
});
