import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  correlateFleetAndGhostex,
  DEFAULT_CWD_KEYS,
  DEFAULT_LINK_KEYS,
  DEFAULT_RECONCILE_POLICY,
  detectCompletion,
  gascityActivityToGhostex,
  gascityFleetToGhostex,
  gascityLifecycleToGhostex,
  gascitySessionCwd,
  gascitySessionLink,
  ghostexActivityToGascity,
  ghostexLifecycleToGascity,
  ghostexSessionToFleetActivity,
  isAgentCompleted,
  normalizeCwd,
  projectGascitySessionToGhostex,
  reconcile,
  type BridgeResult,
  type GascityAgentLike,
  type GascityFleetLike,
  type GascitySessionLike,
} from './stateSync.ts';
import type {
  GhostexLifecycleState,
  GhostexPresentationSession,
  GhostexSessionActivity,
} from './types.ts';

// ---- fixtures --------------------------------------------------------------

function gcSession(s: Partial<GascitySessionLike> & { id: string }): GascitySessionLike {
  return {
    session_name: s.id,
    template: 'gastown.polecat',
    title: '',
    state: 'idle',
    running: false,
    attached: false,
    created_at: '2026-06-13T00:00:00Z',
    ...s,
  };
}

function gcAgent(a: Partial<GascityAgentLike> & { name: string }): GascityAgentLike {
  return {
    state: 'idle',
    running: false,
    suspended: false,
    available: true,
    ...a,
  };
}

function gxSession(s: {
  sessionId: string;
  activity?: GhostexSessionActivity;
  lifecycleState?: GhostexLifecycleState;
  kind?: 'agent' | 'terminal';
  cwd?: string;
  agentId?: string;
}): GhostexPresentationSession {
  const base: GhostexPresentationSession = {
    sessionId: s.sessionId,
    projectId: 'P1',
    groupId: 'G1',
    title: s.sessionId,
    kind: s.kind ?? 'agent',
    activity: s.activity ?? 'idle',
    lifecycleState: s.lifecycleState ?? 'running',
    surface: 'workspace',
    isFavorite: false,
    isPinned: false,
    sortKey: s.sessionId,
    createdAt: '2026-06-13T00:00:00Z',
    updatedAt: '2026-06-13T00:00:00Z',
  };
  return {
    ...base,
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(s.agentId ? { agentId: s.agentId } : {}),
  };
}

// ---- gas-city → Ghostex activity -------------------------------------------

test('gascityActivityToGhostex: explicit attention flag wins over everything', () => {
  assert.equal(gascityActivityToGhostex({ attention: true, activity: 'in-turn' }), 'attention');
});

test('gascityActivityToGhostex: attention tokens in state or activity', () => {
  assert.equal(gascityActivityToGhostex({ state: 'blocked' }), 'attention');
  assert.equal(gascityActivityToGhostex({ activity: 'awaiting_input' }), 'attention');
  assert.equal(gascityActivityToGhostex({ state: 'NEEDS-ATTENTION' }), 'attention');
});

test('gascityActivityToGhostex: working tokens, case/separator-insensitive', () => {
  assert.equal(gascityActivityToGhostex({ activity: 'in-turn' }), 'working');
  assert.equal(gascityActivityToGhostex({ activity: 'In Turn' }), 'working');
  assert.equal(gascityActivityToGhostex({ activity: 'in_turn' }), 'working');
  assert.equal(gascityActivityToGhostex({ state: 'busy' }), 'working');
  assert.equal(gascityActivityToGhostex({ state: 'thinking' }), 'working');
});

test('gascityActivityToGhostex: a merely-running session with no work signal is idle', () => {
  assert.equal(gascityActivityToGhostex({ running: true, state: 'running' }), 'idle');
  assert.equal(gascityActivityToGhostex({ activity: 'idle' }), 'idle');
  assert.equal(gascityActivityToGhostex({}), 'idle');
  assert.equal(gascityActivityToGhostex({ state: 'something-unknown' }), 'idle');
});

// ---- gas-city → Ghostex lifecycle ------------------------------------------

test('gascityLifecycleToGhostex: suspended is sleeping, even when running', () => {
  assert.equal(gascityLifecycleToGhostex({ suspended: true, running: true }), 'sleeping');
});

test('gascityLifecycleToGhostex: sleeping/stopped/missing tokens', () => {
  assert.equal(gascityLifecycleToGhostex({ state: 'asleep' }), 'sleeping');
  assert.equal(gascityLifecycleToGhostex({ state: 'paused' }), 'sleeping');
  assert.equal(gascityLifecycleToGhostex({ state: 'exited' }), 'stopped');
  assert.equal(gascityLifecycleToGhostex({ state: 'completed' }), 'stopped');
  assert.equal(gascityLifecycleToGhostex({ state: 'stranded' }), 'missing');
});

test('gascityLifecycleToGhostex: running boolean, and unknown when non-running with no token', () => {
  assert.equal(gascityLifecycleToGhostex({ running: true, state: 'live' }), 'running');
  assert.equal(gascityLifecycleToGhostex({ running: false, state: 'live' }), 'unknown');
  assert.equal(gascityLifecycleToGhostex({}), 'unknown');
});

test('gascityLifecycleToGhostex: a terminal token overrides a stale running flag', () => {
  assert.equal(gascityLifecycleToGhostex({ running: true, state: 'killed' }), 'stopped');
});

// ---- Ghostex → gas-city vocabulary -----------------------------------------

test('ghostexActivityToGascity: closed mapping', () => {
  assert.equal(ghostexActivityToGascity('working'), 'in-turn');
  assert.equal(ghostexActivityToGascity('attention'), 'attention');
  assert.equal(ghostexActivityToGascity('idle'), 'idle');
});

test('ghostexLifecycleToGascity: running/state pairs for every lifecycle', () => {
  assert.deepEqual(ghostexLifecycleToGascity('running'), { running: true, state: 'running' });
  assert.deepEqual(ghostexLifecycleToGascity('sleeping'), { running: false, state: 'sleeping' });
  assert.deepEqual(ghostexLifecycleToGascity('stopped'), { running: false, state: 'stopped' });
  assert.deepEqual(ghostexLifecycleToGascity('missing'), { running: false, state: 'missing' });
  assert.deepEqual(ghostexLifecycleToGascity('unknown'), { running: false, state: 'unknown' });
});

// ---- completion ------------------------------------------------------------

test('isAgentCompleted: agent-kind stopped sessions, undefined kind treated as agent', () => {
  assert.equal(isAgentCompleted({ kind: 'agent', lifecycleState: 'stopped' }), true);
  assert.equal(isAgentCompleted({ lifecycleState: 'stopped' }), true);
  assert.equal(isAgentCompleted({ kind: 'terminal', lifecycleState: 'stopped' }), false);
  assert.equal(isAgentCompleted({ kind: 'agent', lifecycleState: 'running' }), false);
});

test('detectCompletion: ended on transition into stopped', () => {
  assert.deepEqual(
    detectCompletion(
      { activity: 'working', lifecycleState: 'running' },
      { activity: 'idle', lifecycleState: 'stopped' },
    ),
    { kind: 'ended' },
  );
});

test('detectCompletion: no ended when already stopped', () => {
  assert.equal(
    detectCompletion(
      { activity: 'idle', lifecycleState: 'stopped' },
      { activity: 'idle', lifecycleState: 'stopped' },
    ),
    null,
  );
});

test('detectCompletion: turn on working→idle while running', () => {
  assert.deepEqual(
    detectCompletion(
      { activity: 'working', lifecycleState: 'running' },
      { activity: 'idle', lifecycleState: 'running' },
    ),
    { kind: 'turn' },
  );
});

test('detectCompletion: null when nothing concluded', () => {
  assert.equal(
    detectCompletion(
      { activity: 'idle', lifecycleState: 'running' },
      { activity: 'working', lifecycleState: 'running' },
    ),
    null,
  );
  // working → attention is not a turn completion
  assert.equal(
    detectCompletion(
      { activity: 'working', lifecycleState: 'running' },
      { activity: 'attention', lifecycleState: 'running' },
    ),
    null,
  );
});

// ---- cwd / link extraction -------------------------------------------------

test('normalizeCwd: trims whitespace and trailing slashes, empty → undefined', () => {
  assert.equal(normalizeCwd('  /a/b/  '), '/a/b');
  assert.equal(normalizeCwd('/a/b///'), '/a/b');
  assert.equal(normalizeCwd('/a/b'), '/a/b');
  assert.equal(normalizeCwd('   '), undefined);
  assert.equal(normalizeCwd(''), undefined);
  assert.equal(normalizeCwd(undefined), undefined);
});

test('gascitySessionCwd: reads the first populated default key, normalised', () => {
  assert.equal(
    gascitySessionCwd(gcSession({ id: 's1', metadata: { work_dir: '/wt/s1/' } })),
    '/wt/s1',
  );
  // later default keys are consulted when earlier ones are absent
  assert.equal(gascitySessionCwd(gcSession({ id: 's1', metadata: { cwd: '/c' } })), '/c');
  // blank values are skipped
  assert.equal(
    gascitySessionCwd(gcSession({ id: 's1', metadata: { work_dir: '   ', cwd: '/c2' } })),
    '/c2',
  );
  // no metadata at all
  assert.equal(gascitySessionCwd(gcSession({ id: 's1' })), undefined);
});

test('gascitySessionCwd: honours custom cwd keys', () => {
  assert.equal(
    gascitySessionCwd(gcSession({ id: 's1', metadata: { repo_path: '/r' } }), {
      cwdKeys: ['repo_path'],
    }),
    '/r',
  );
});

test('gascitySessionLink: reads explicit link keys; default + custom', () => {
  assert.equal(
    gascitySessionLink(gcSession({ id: 's1', metadata: { 'ghostex.sessionId': 'S9' } })),
    'S9',
  );
  assert.equal(
    gascitySessionLink(gcSession({ id: 's1', metadata: { gx: 'S7' } }), { linkKeys: ['gx'] }),
    'S7',
  );
  assert.equal(gascitySessionLink(gcSession({ id: 's1' })), undefined);
});

test('default key lists are the documented ones', () => {
  assert.ok(DEFAULT_CWD_KEYS.includes('work_dir'));
  assert.ok(DEFAULT_LINK_KEYS.includes('ghostex.sessionId'));
});

// ---- Direction A: gas-city session → Ghostex row ---------------------------

test('projectGascitySessionToGhostex: ids namespaced, fields mapped', () => {
  const row = projectGascitySessionToGhostex(
    gcSession({
      id: 'sess-1',
      session_name: 'gastown.toast',
      title: 'Toast',
      state: 'in-turn',
      running: true,
      rig: 'cockpit',
      active_bead: 'zmux-1',
      metadata: { work_dir: '/wt/toast' },
    }),
    { cityName: 'blackrim-hq' },
  );
  assert.equal(row.sessionId, 'gascity:session:blackrim-hq:sess-1');
  assert.equal(row.projectId, 'gascity:project:blackrim-hq');
  assert.equal(row.groupId, 'gascity:group:blackrim-hq:cockpit');
  assert.equal(row.title, 'Toast');
  assert.equal(row.kind, 'agent');
  assert.equal(row.activity, 'working');
  assert.equal(row.lifecycleState, 'running');
  assert.equal(row.surface, 'workspace');
  assert.equal(row.agentId, 'gastown.polecat');
  assert.equal(row.cwd, '/wt/toast');
  assert.equal(row.subtitle, 'zmux-1');
  assert.equal(row.sortKey, 'gastown.toast');
});

test('projectGascitySessionToGhostex: agent enriches activity, suspend, and name', () => {
  const row = projectGascitySessionToGhostex(
    gcSession({ id: 's', template: '', title: '', state: '', metadata: {} }),
    {
      cityName: 'c',
      agent: gcAgent({
        name: 'gastown.mayor',
        activity: 'in-turn',
        suspended: true,
        display_name: 'Mayor',
      }),
    },
  );
  // session.activity absent → falls back to agent.activity (working)…
  assert.equal(row.activity, 'working');
  // …but a suspended agent forces sleeping lifecycle
  assert.equal(row.lifecycleState, 'sleeping');
  // template empty → agentId falls back to agent.name
  assert.equal(row.agentId, 'gastown.mayor');
  assert.equal(row.agentName, 'Mayor');
});

test('projectGascitySessionToGhostex: fallbacks for title, rig, id, updatedAt, agentId', () => {
  const row = projectGascitySessionToGhostex(
    gcSession({
      id: 'only-id',
      session_name: '',
      title: '',
      template: '',
      agent_kind: 'polecat',
      created_at: '2026-01-01T00:00:00Z',
    }),
    { cityName: 'c' },
  );
  assert.equal(row.title, 'only-id'); // title and session_name empty → id
  assert.equal(row.groupId, 'gascity:group:c:fleet'); // no rig → fleet
  assert.equal(row.sortKey, 'only-id'); // session_name empty → id
  assert.equal(row.updatedAt, '2026-01-01T00:00:00Z'); // no last_active → created_at
  assert.equal(row.agentId, 'polecat'); // template + agent absent → agent_kind
  assert.equal(row.agentName, undefined);
  assert.equal(row.cwd, undefined);
  assert.equal(row.subtitle, undefined);
});

test('projectGascitySessionToGhostex: honours a custom id prefix', () => {
  const row = projectGascitySessionToGhostex(gcSession({ id: 's' }), {
    cityName: 'c',
    options: { idPrefix: 'gc' },
  });
  assert.equal(row.sessionId, 'gc:session:c:s');
});

test('projectGascitySessionToGhostex: no agent id at all leaves agentId unset', () => {
  const row = projectGascitySessionToGhostex(
    gcSession({ id: 's', template: '' }), // no template, no agent, no agent_kind
    { cityName: 'c' },
  );
  assert.equal(row.agentId, undefined);
});

// ---- Direction A: whole fleet → snapshot -----------------------------------

test('gascityFleetToGhostex: one project per city, group per rig, sorted', () => {
  const fleet: GascityFleetLike = {
    sessionsByCity: {
      zebra: [gcSession({ id: 'z1', rig: 'r1' })],
      alpha: [
        gcSession({ id: 'a1', session_name: 'a1', rig: 'r1', running: true, state: 'in-turn' }),
        gcSession({ id: 'a2', session_name: 'a2', rig: 'r2' }),
      ],
    },
    agentsByCity: {
      alpha: [gcAgent({ name: 'agent-a1', session: { name: 'a1' }, suspended: false })],
    },
  };
  const snap = gascityFleetToGhostex(fleet);
  assert.equal(snap.revision, 0);
  assert.equal(snap.generatedAt, '');
  // cities sorted: alpha before zebra
  assert.deepEqual(
    snap.projects.map((p) => p.projectId),
    ['gascity:project:alpha', 'gascity:project:zebra'],
  );
  // alpha has two groups (r1, r2); zebra has one (r1)
  const alphaGroups = snap.groups.filter((g) => g.projectId === 'gascity:project:alpha');
  assert.equal(alphaGroups.length, 2);
  const r1 = alphaGroups.find((g) => g.title === 'r1');
  assert.ok(r1);
  assert.deepEqual(r1?.sessionIds, ['gascity:session:alpha:a1']);
  assert.equal(snap.sessions.length, 3);
});

test('gascityFleetToGhostex: sessions sharing a rig collapse into one group', () => {
  const fleet: GascityFleetLike = {
    sessionsByCity: {
      c: [
        gcSession({ id: 's1', session_name: 's1', rig: 'r1' }),
        gcSession({ id: 's2', session_name: 's2', rig: 'r1' }),
      ],
    },
    agentsByCity: {},
  };
  const snap = gascityFleetToGhostex(fleet, { idPrefix: 'gc', cwdKeys: ['work_dir'] });
  const groups = snap.groups.filter((g) => g.projectId === 'gc:project:c');
  assert.equal(groups.length, 1); // both sessions land in the single r1 group
  assert.equal(groups[0]?.title, 'r1');
  assert.equal(groups[0]?.sessionIds.length, 2);
  assert.equal(snap.sessions[0]?.sessionId, 'gc:session:c:s1'); // custom prefix applied
});

test('gascityFleetToGhostex: empty cities are skipped entirely', () => {
  const fleet: GascityFleetLike = {
    sessionsByCity: { empty: [], full: [gcSession({ id: 's' })] },
    agentsByCity: {},
  };
  const snap = gascityFleetToGhostex(fleet);
  assert.deepEqual(
    snap.projects.map((p) => p.projectId),
    ['gascity:project:full'],
  );
  assert.equal(snap.sessions.length, 1);
});

test('gascityFleetToGhostex: agents pair to sessions by name; first wins on dupes', () => {
  const fleet: GascityFleetLike = {
    sessionsByCity: { c: [gcSession({ id: 's', session_name: 'dup', state: '', running: false })] },
    agentsByCity: {
      c: [
        gcAgent({ name: 'first', session: { name: 'dup' }, suspended: true }),
        gcAgent({ name: 'second', session: { name: 'dup' }, suspended: false }),
        gcAgent({ name: 'no-session' }), // session undefined → skipped
      ],
    },
  };
  const snap = gascityFleetToGhostex(fleet);
  // first agent (suspended) won the pairing → sleeping
  assert.equal(snap.sessions[0]?.lifecycleState, 'sleeping');
});

// ---- Direction B: Ghostex session → fleet overlay --------------------------

test('ghostexSessionToFleetActivity: maps activity, liveness, attention, completion', () => {
  const overlay = ghostexSessionToFleetActivity(
    gxSession({
      sessionId: 'S1',
      activity: 'attention',
      lifecycleState: 'running',
      cwd: '/wt/x/',
      agentId: 'claude',
    }),
  );
  assert.equal(overlay.ghostexSessionId, 'S1');
  assert.equal(overlay.activity, 'attention');
  assert.equal(overlay.attention, true);
  assert.equal(overlay.running, true);
  assert.equal(overlay.state, 'running');
  assert.equal(overlay.completed, false);
  assert.equal(overlay.cwd, '/wt/x'); // normalised
  assert.equal(overlay.agentId, 'claude');
});

test('ghostexSessionToFleetActivity: a stopped agent session is completed; cwd/agentId optional', () => {
  const overlay = ghostexSessionToFleetActivity(
    gxSession({ sessionId: 'S2', activity: 'idle', lifecycleState: 'stopped' }),
  );
  assert.equal(overlay.completed, true);
  assert.equal(overlay.running, false);
  assert.equal(overlay.state, 'stopped');
  assert.equal(overlay.attention, false);
  assert.equal(overlay.cwd, undefined);
  assert.equal(overlay.agentId, undefined);
});

// ---- reconcile -------------------------------------------------------------

test('reconcile: default policy — activity from Ghostex, lifecycle from gas-city', () => {
  const gc = gcSession({ id: 's', state: 'idle', running: true });
  const gx = gxSession({ sessionId: 'S', activity: 'working', lifecycleState: 'sleeping' });
  const r = reconcile(gc, gx);
  assert.equal(r.activity, 'working'); // Ghostex wins activity
  assert.equal(r.lifecycleState, 'running'); // gas-city (running:true) wins lifecycle
  assert.equal(r.completed, false);
});

test('reconcile: gascity activity / ghostex lifecycle policy', () => {
  const gc = gcSession({ id: 's', state: 'in-turn', running: true });
  const gx = gxSession({ sessionId: 'S', activity: 'idle', lifecycleState: 'stopped' });
  const r = reconcile(gc, gx, { activity: 'gascity', lifecycle: 'ghostex' });
  assert.equal(r.activity, 'working'); // gas-city (in-turn) wins
  assert.equal(r.lifecycleState, 'stopped'); // Ghostex wins lifecycle
  assert.equal(r.completed, true); // agent + stopped
});

test('reconcile: agent suspend feeds the gas-city lifecycle branch', () => {
  const gc = gcSession({ id: 's', state: 'idle', running: true });
  const gx = gxSession({ sessionId: 'S', activity: 'idle', lifecycleState: 'running' });
  const r = reconcile(gc, gx, DEFAULT_RECONCILE_POLICY, gcAgent({ name: 'a', suspended: true }));
  assert.equal(r.lifecycleState, 'sleeping');
});

// ---- correlate -------------------------------------------------------------

function fleetOf(...sessions: GascitySessionLike[]): GascityFleetLike {
  return { sessionsByCity: { c: sessions }, agentsByCity: {} };
}

test('correlateFleetAndGhostex: matches by explicit link id', () => {
  const gc = gcSession({ id: 's', metadata: { 'ghostex.sessionId': 'S1' } });
  const gx = gxSession({ sessionId: 'S1', activity: 'working' });
  const result = correlateFleetAndGhostex(fleetOf(gc), [gx]);
  assert.equal(result.bridged.length, 1);
  assert.equal(result.bridged[0]?.via, 'link');
  assert.equal(result.bridged[0]?.key, 'S1');
  assert.equal(result.bridged[0]?.activity, 'working');
  assert.equal(result.gascityOnly.length, 0);
  assert.equal(result.ghostexOnly.length, 0);
});

test('correlateFleetAndGhostex: matches by working directory', () => {
  const gc = gcSession({ id: 's', metadata: { work_dir: '/wt/s/' } });
  const gx = gxSession({ sessionId: 'S1', cwd: '/wt/s' });
  const result = correlateFleetAndGhostex(fleetOf(gc), [gx]);
  assert.equal(result.bridged.length, 1);
  assert.equal(result.bridged[0]?.via, 'cwd');
  assert.equal(result.bridged[0]?.key, '/wt/s');
});

test('correlateFleetAndGhostex: an explicit link wins over a cwd match', () => {
  const gc = gcSession({
    id: 's',
    metadata: { 'ghostex.sessionId': 'S-link', work_dir: '/wt/s' },
  });
  const linked = gxSession({ sessionId: 'S-link', cwd: '/elsewhere' });
  const byCwd = gxSession({ sessionId: 'S-cwd', cwd: '/wt/s' });
  const result = correlateFleetAndGhostex(fleetOf(gc), [byCwd, linked]);
  assert.equal(result.bridged.length, 1);
  assert.equal(result.bridged[0]?.via, 'link');
  assert.equal(result.bridged[0]?.ghostexSession.sessionId, 'S-link');
  // the cwd candidate stayed unclaimed
  assert.deepEqual(
    result.ghostexOnly.map((s) => s.sessionId),
    ['S-cwd'],
  );
});

test('correlateFleetAndGhostex: each Ghostex session binds at most once', () => {
  const a = gcSession({ id: 'a', metadata: { 'ghostex.sessionId': 'S1' } });
  const b = gcSession({ id: 'b', metadata: { 'ghostex.sessionId': 'S1' } });
  const gx = gxSession({ sessionId: 'S1' });
  const result = correlateFleetAndGhostex(fleetOf(a, b), [gx]);
  assert.equal(result.bridged.length, 1);
  assert.equal(result.bridged[0]?.gascitySession.id, 'a'); // first claimant wins
  assert.deepEqual(
    result.gascityOnly.map((s) => s.session.id),
    ['b'],
  );
});

test('correlateFleetAndGhostex: a used cwd candidate frees the second claimant to fall through', () => {
  const a = gcSession({ id: 'a', metadata: { work_dir: '/shared' } });
  const b = gcSession({ id: 'b', metadata: { work_dir: '/shared' } });
  const gx = gxSession({ sessionId: 'S1', cwd: '/shared' });
  const result = correlateFleetAndGhostex(fleetOf(a, b), [gx]);
  assert.equal(result.bridged.length, 1);
  assert.deepEqual(
    result.gascityOnly.map((s) => s.session.id),
    ['b'],
  );
});

test('correlateFleetAndGhostex: a link to a missing id falls back to cwd', () => {
  const gc = gcSession({
    id: 's',
    metadata: { 'ghostex.sessionId': 'nope', work_dir: '/wt/s' },
  });
  const gx = gxSession({ sessionId: 'S1', cwd: '/wt/s' });
  const result = correlateFleetAndGhostex(fleetOf(gc), [gx]);
  assert.equal(result.bridged.length, 1);
  assert.equal(result.bridged[0]?.via, 'cwd');
});

test('correlateFleetAndGhostex: unmatched rows split into gascityOnly / ghostexOnly', () => {
  const gc = gcSession({ id: 's' }); // no link, no cwd
  const gx = gxSession({ sessionId: 'S1', cwd: '/x' });
  const result = correlateFleetAndGhostex(fleetOf(gc), [gx]);
  assert.equal(result.bridged.length, 0);
  assert.deepEqual(
    result.gascityOnly.map((s) => s.session.id),
    ['s'],
  );
  assert.deepEqual(
    result.ghostexOnly.map((s) => s.sessionId),
    ['S1'],
  );
});

test('correlateFleetAndGhostex: bridged carries reconciled activity + lifecycle + city', () => {
  const fleet: GascityFleetLike = {
    sessionsByCity: {
      c: [gcSession({ id: 's', state: 'idle', running: true, metadata: { work_dir: '/w' } })],
    },
    agentsByCity: {},
  };
  const gx = gxSession({ sessionId: 'S', activity: 'attention', lifecycleState: 'running', cwd: '/w' });
  const result = correlateFleetAndGhostex(fleet, [gx]);
  const b = result.bridged[0];
  assert.equal(b?.cityName, 'c');
  assert.equal(b?.activity, 'attention'); // ghostex
  assert.equal(b?.lifecycleState, 'running'); // gascity running
  assert.equal(b?.completed, false);
});

test('correlateFleetAndGhostex: honours a custom policy + key options', () => {
  const gc = gcSession({ id: 's', state: 'in-turn', running: true, metadata: { gx_dir: '/w' } });
  const gx = gxSession({ sessionId: 'S', activity: 'idle', lifecycleState: 'stopped', cwd: '/w' });
  const result = correlateFleetAndGhostex(fleet1(gc), [gx], {
    cwdKeys: ['gx_dir'],
    policy: { activity: 'gascity', lifecycle: 'ghostex' },
  });
  assert.equal(result.bridged.length, 1);
  assert.equal(result.bridged[0]?.activity, 'working'); // gascity in-turn
  assert.equal(result.bridged[0]?.lifecycleState, 'stopped'); // ghostex
  assert.equal(result.bridged[0]?.completed, true);
});

function fleet1(s: GascitySessionLike): GascityFleetLike {
  return { sessionsByCity: { c: [s] }, agentsByCity: {} };
}

test('correlateFleetAndGhostex: empty inputs yield empty result', () => {
  const result: BridgeResult = correlateFleetAndGhostex(
    { sessionsByCity: {}, agentsByCity: {} },
    [],
  );
  assert.deepEqual(result, { bridged: [], gascityOnly: [], ghostexOnly: [] });
});

test('correlateFleetAndGhostex: an agent pairs in to drive the reconciled lifecycle', () => {
  const fleet: GascityFleetLike = {
    sessionsByCity: {
      c: [gcSession({ id: 's', session_name: 'sn', running: true, metadata: { work_dir: '/w' } })],
    },
    agentsByCity: { c: [gcAgent({ name: 'a', session: { name: 'sn' }, suspended: true })] },
  };
  const gx = gxSession({ sessionId: 'S', lifecycleState: 'running', cwd: '/w' });
  const result = correlateFleetAndGhostex(fleet, [gx]);
  // default policy takes lifecycle from gas-city, and the paired suspended agent → sleeping
  assert.equal(result.bridged[0]?.lifecycleState, 'sleeping');
});

// ---- duplicate Ghostex ids / cwds are indexed first-wins -------------------

test('correlateFleetAndGhostex: a duplicate cwd indexes to the first session seen', () => {
  const gc = gcSession({ id: 's', metadata: { work_dir: '/dup' } });
  const first = gxSession({ sessionId: 'S1', cwd: '/dup' });
  const second = gxSession({ sessionId: 'S2', cwd: '/dup' }); // same cwd, distinct id
  const result = correlateFleetAndGhostex(fleetOf(gc), [first, second]);
  assert.equal(result.bridged.length, 1);
  assert.equal(result.bridged[0]?.ghostexSession.sessionId, 'S1'); // first-wins indexing
  // the second (unindexed) copy stays unclaimed
  assert.deepEqual(
    result.ghostexOnly.map((s) => s.sessionId),
    ['S2'],
  );
});

test('correlateFleetAndGhostex: a duplicate id indexes once and both copies are consumed', () => {
  const gc = gcSession({ id: 's', metadata: { 'ghostex.sessionId': 'S1' } });
  const first = gxSession({ sessionId: 'S1', activity: 'working' });
  const second = gxSession({ sessionId: 'S1', activity: 'idle' }); // same id
  const result = correlateFleetAndGhostex(fleetOf(gc), [first, second]);
  assert.equal(result.bridged.length, 1);
  assert.equal(result.bridged[0]?.activity, 'working'); // first-indexed copy bound
  // both copies share the now-used id, so neither lingers in ghostexOnly
  assert.equal(result.ghostexOnly.length, 0);
});
