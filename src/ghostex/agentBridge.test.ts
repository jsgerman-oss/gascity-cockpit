import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  deriveAgentId,
  deriveCwd,
  deriveProjectMatch,
  deriveLaunchRequest,
  resolveProjectId,
  linkageMetadata,
  readLinkage,
  launchAgentForBead,
  LINKAGE_KEYS,
  type AgentLauncher,
  type AgentLinkage,
  type BeadLike,
  type LinkageRecorder,
  type LinkageRecordResult,
} from './agentBridge.ts';
import type { GhostexProject, GhostexSession } from './types.ts';

// --- Fixtures ---------------------------------------------------------------

function project(projectId: string, path?: string): GhostexProject {
  return {
    projectId,
    name: projectId,
    isFavorite: false,
    isPinned: false,
    createdAt: '',
    updatedAt: '',
    ...(path !== undefined ? { path } : {}),
  };
}

function session(over: Partial<GhostexSession> = {}): GhostexSession {
  return {
    sessionId: 'G7abc',
    projectId: 'P1xyz',
    globalRef: 'S1:P1xyz:G7abc',
    kind: 'agent',
    title: 'claude',
    lifecycleState: 'running',
    surface: 'workspace',
    isFavorite: false,
    isPinned: false,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

function bead(metadata?: Record<string, string>, id = 'zmux-1'): BeadLike {
  return metadata ? { id, metadata } : { id };
}

/** A scripted Ghostex surface that records its calls. */
class FakeLauncher implements AgentLauncher {
  listCalls = 0;
  createCalls: Array<{ projectId: string; agentId: string; cwd?: string }> = [];
  constructor(
    private readonly opts: {
      projects?: GhostexProject[];
      listError?: unknown;
      createError?: unknown;
      session?: GhostexSession;
    } = {},
  ) {}
  async listProjects(): Promise<readonly GhostexProject[]> {
    this.listCalls++;
    if (this.opts.listError !== undefined) throw this.opts.listError;
    return this.opts.projects ?? [];
  }
  async createAgentSession(params: { projectId: string; agentId: string; cwd?: string }): Promise<GhostexSession> {
    this.createCalls.push(params);
    if (this.opts.createError !== undefined) throw this.opts.createError;
    return this.opts.session ?? session({ projectId: params.projectId });
  }
}

function recorder(
  result: LinkageRecordResult = { ok: true },
): { calls: Array<{ beadId: string; metadata: Record<string, string> }>; fn: LinkageRecorder } {
  const calls: Array<{ beadId: string; metadata: Record<string, string> }> = [];
  return {
    calls,
    fn: async (beadId, metadata) => {
      calls.push({ beadId, metadata });
      return result;
    },
  };
}

// --- deriveAgentId ----------------------------------------------------------

test('deriveAgentId honors the explicit override first', () => {
  assert.equal(
    deriveAgentId({ 'ghostex.agentId': 'codex', 'gc.provider': 'claude', 'gc.run_target': 'x-y' }),
    'codex',
  );
});

test('deriveAgentId falls back to gc.provider, then the run_target head', () => {
  assert.equal(deriveAgentId({ 'gc.provider': 'claude' }), 'claude');
  assert.equal(deriveAgentId({ 'gc.run_target': 'claude-opus' }), 'claude');
  assert.equal(deriveAgentId({ 'gc.run_target': 'codex/gpt55' }), 'codex');
  assert.equal(deriveAgentId({ 'gc.run_target': 'codex' }), 'codex');
});

test('deriveAgentId skips blank values and returns undefined when nothing usable', () => {
  assert.equal(deriveAgentId({ 'gc.provider': '   ', 'gc.run_target': 'claude-opus' }), 'claude');
  assert.equal(deriveAgentId({ 'gc.run_target': '-opus' }), undefined); // empty head
  assert.equal(deriveAgentId({}), undefined);
  assert.equal(deriveAgentId(undefined), undefined);
});

// --- deriveCwd / deriveProjectMatch ----------------------------------------

test('deriveCwd prefers work_dir, then repo', () => {
  assert.equal(deriveCwd({ work_dir: '/wt', repo: '/repo' }), '/wt');
  assert.equal(deriveCwd({ repo: '/repo' }), '/repo');
  assert.equal(deriveCwd({}), undefined);
});

test('deriveProjectMatch prefers repo, then work_dir', () => {
  assert.equal(deriveProjectMatch({ work_dir: '/wt', repo: '/repo' }), '/repo');
  assert.equal(deriveProjectMatch({ work_dir: '/wt' }), '/wt');
  assert.equal(deriveProjectMatch({}), undefined);
});

// --- deriveLaunchRequest ----------------------------------------------------

test('deriveLaunchRequest fails when no agent can be derived', () => {
  const r = deriveLaunchRequest(bead({ repo: '/repo' }, 'zmux-9'));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'missingAgent');
    assert.match(r.detail, /zmux-9/);
  }
});

test('deriveLaunchRequest builds a full request from rich metadata', () => {
  const r = deriveLaunchRequest(
    bead({
      'gc.provider': 'claude',
      work_dir: '/wt/furiosa',
      repo: '/repo',
      'ghostex.projectId': 'Ppinned',
    }),
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.request, {
      beadId: 'zmux-1',
      agentId: 'claude',
      cwd: '/wt/furiosa',
      projectMatch: '/repo',
      explicitProjectId: 'Ppinned',
    });
  }
});

test('deriveLaunchRequest omits absent optional fields', () => {
  const r = deriveLaunchRequest(bead({ 'gc.provider': 'codex' }));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.request, { beadId: 'zmux-1', agentId: 'codex' });
});

// --- resolveProjectId -------------------------------------------------------

test('resolveProjectId returns undefined when the request has no path hints', () => {
  assert.equal(resolveProjectId([project('P1', '/repo')], {}), undefined);
});

test('resolveProjectId matches an exact path (repo first, then cwd)', () => {
  const projects = [project('Pa', '/other'), project('Pb', '/repo')];
  assert.equal(resolveProjectId(projects, { projectMatch: '/repo', cwd: '/wt' }), 'Pb');
  // projectMatch absent → match on cwd, tolerating a trailing slash.
  assert.equal(resolveProjectId(projects, { cwd: '/repo/' }), 'Pb');
});

test('resolveProjectId matches a lone-root path', () => {
  assert.equal(resolveProjectId([project('Proot', '/')], { projectMatch: '/' }), 'Proot');
});

test('resolveProjectId falls back to an ancestor project, segment-aware', () => {
  const projects = [project('Pbc', '/a/bc'), project('Pb', '/a/b')];
  // cwd lives under /a/b — must not match the sibling /a/bc.
  assert.equal(resolveProjectId(projects, { cwd: '/a/b/sub/deep' }), 'Pb');
});

test('resolveProjectId falls back to a basename match as a last resort', () => {
  const projects = [project('Pmoved', '/elsewhere/gascity-cockpit')];
  assert.equal(resolveProjectId(projects, { projectMatch: '/Users/jay/Code/gascity-cockpit' }), 'Pmoved');
  // basename match also works when the project path has no directory separator.
  assert.equal(resolveProjectId([project('Pflat', 'gascity-cockpit')], { cwd: '/x/gascity-cockpit' }), 'Pflat');
});

test('resolveProjectId skips projects without a path and returns undefined on no match', () => {
  assert.equal(resolveProjectId([project('Pnone'), project('Pblank', '  ')], { projectMatch: '/repo' }), undefined);
});

// --- linkageMetadata / readLinkage -----------------------------------------

const fullLinkage: AgentLinkage = {
  beadId: 'zmux-1',
  sessionId: 'G7abc',
  globalRef: 'S1:P1xyz:G7abc',
  projectId: 'P1xyz',
  agentId: 'claude',
};

test('linkageMetadata emits the four namespaced keys', () => {
  assert.deepEqual(linkageMetadata(fullLinkage), {
    'ghostex.globalRef': 'S1:P1xyz:G7abc',
    'ghostex.sessionId': 'G7abc',
    'ghostex.projectId': 'P1xyz',
    'ghostex.agentId': 'claude',
  });
});

test('readLinkage round-trips a full linkage', () => {
  const got = readLinkage(bead(linkageMetadata(fullLinkage)));
  assert.deepEqual(got, fullLinkage);
});

test('readLinkage returns null when no linkage is present', () => {
  assert.equal(readLinkage(bead({ repo: '/repo' })), null);
  assert.equal(readLinkage(bead()), null);
});

test('readLinkage derives the session id from a ref-only linkage', () => {
  const got = readLinkage(bead({ [LINKAGE_KEYS.globalRef]: 'S1:P1xyz:G7abc' }));
  assert.deepEqual(got, {
    beadId: 'zmux-1',
    sessionId: 'G7abc',
    globalRef: 'S1:P1xyz:G7abc',
    projectId: '',
    agentId: '',
  });
});

test('readLinkage falls back to the session id for the ref when only the id is stored', () => {
  const got = readLinkage(bead({ [LINKAGE_KEYS.sessionId]: 'G7abc' }));
  assert.equal(got?.globalRef, 'G7abc');
});

test('readLinkage returns null when a ref has no usable trailing segment', () => {
  assert.equal(readLinkage(bead({ [LINKAGE_KEYS.globalRef]: ':' })), null);
});

// --- launchAgentForBead -----------------------------------------------------

test('launchAgentForBead launches, builds the S:P:G linkage, and records it', async () => {
  const launcher = new FakeLauncher({
    projects: [project('P1xyz', '/repo')],
    session: session({ sessionId: 'G7abc', globalRef: 'S1:P1xyz:G7abc', cwd: '/wt/furiosa' }),
  });
  const rec = recorder();
  const out = await launchAgentForBead(
    { launcher, recordLinkage: rec.fn },
    bead({ 'gc.provider': 'claude', repo: '/repo', work_dir: '/wt/furiosa' }),
  );

  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.recorded, true);
    assert.deepEqual(out.linkage, {
      beadId: 'zmux-1',
      sessionId: 'G7abc',
      globalRef: 'S1:P1xyz:G7abc',
      projectId: 'P1xyz',
      agentId: 'claude',
      cwd: '/wt/furiosa',
    });
  }
  // The worktree cwd is threaded into create-agent.
  assert.deepEqual(launcher.createCalls, [{ projectId: 'P1xyz', agentId: 'claude', cwd: '/wt/furiosa' }]);
  // The recorded metadata is keyed by the global ref.
  assert.deepEqual(rec.calls, [{ beadId: 'zmux-1', metadata: linkageMetadata(out.ok ? out.linkage : fullLinkage) }]);
});

test('launchAgentForBead honors an explicit projectId and skips project listing', async () => {
  const launcher = new FakeLauncher({ session: session({ projectId: 'Ppinned' }) });
  const out = await launchAgentForBead(
    { launcher, recordLinkage: recorder().fn },
    bead({ 'gc.provider': 'codex', 'ghostex.projectId': 'Ppinned' }),
  );
  assert.equal(out.ok, true);
  assert.equal(launcher.listCalls, 0);
  assert.deepEqual(launcher.createCalls, [{ projectId: 'Ppinned', agentId: 'codex' }]);
});

test('launchAgentForBead surfaces a missing agent without any side effects', async () => {
  const launcher = new FakeLauncher();
  const rec = recorder();
  const out = await launchAgentForBead({ launcher, recordLinkage: rec.fn }, bead({ repo: '/repo' }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'missingAgent');
  assert.equal(launcher.listCalls, 0);
  assert.equal(launcher.createCalls.length, 0);
  assert.equal(rec.calls.length, 0);
});

test('launchAgentForBead reports noProject when listing projects fails', async () => {
  const launcher = new FakeLauncher({ listError: new Error('gxserver down') });
  const out = await launchAgentForBead(
    { launcher, recordLinkage: recorder().fn },
    bead({ 'gc.provider': 'claude', repo: '/repo' }),
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'noProject');
    assert.match(out.detail, /gxserver down/);
  }
});

test('launchAgentForBead reports noProject when nothing matches, naming the hint', async () => {
  const launcher = new FakeLauncher({ projects: [project('Pa', '/other')] });
  const out = await launchAgentForBead(
    { launcher, recordLinkage: recorder().fn },
    bead({ 'gc.provider': 'claude', repo: '/repo' }),
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'noProject');
    assert.match(out.detail, /\/repo/);
  }
  assert.equal(launcher.createCalls.length, 0);
});

test('launchAgentForBead noProject hint falls back to the bead id when no path is known', async () => {
  // No repo/work_dir and no explicit project → resolution yields nothing.
  const launcher = new FakeLauncher({ projects: [project('Pa', '/other')] });
  const out = await launchAgentForBead(
    { launcher, recordLinkage: recorder().fn },
    bead({ 'gc.provider': 'claude' }, 'zmux-77'),
  );
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.detail, /zmux-77/);
});

test('launchAgentForBead reports launchFailed when create-agent throws (non-Error coerced)', async () => {
  const launcher = new FakeLauncher({ projects: [project('P1xyz', '/repo')], createError: 'boom' });
  const rec = recorder();
  const out = await launchAgentForBead(
    { launcher, recordLinkage: rec.fn },
    bead({ 'gc.provider': 'claude', repo: '/repo' }),
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'launchFailed');
    assert.match(out.detail, /boom/);
  }
  assert.equal(rec.calls.length, 0);
});

test('launchAgentForBead still succeeds (recorded:false) when persisting the linkage fails', async () => {
  const launcher = new FakeLauncher({ projects: [project('P1xyz', '/repo')] });
  const rec = recorder({ ok: false, detail: 'csrf rejected' });
  const out = await launchAgentForBead(
    { launcher, recordLinkage: rec.fn },
    bead({ 'gc.provider': 'claude', repo: '/repo' }),
  );
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.recorded, false);
    assert.equal(out.recordError, 'csrf rejected');
  }
});

test('launchAgentForBead omits cwd from create-agent when the bead has no worktree', async () => {
  const launcher = new FakeLauncher({ projects: [project('P1xyz', '/repo')] });
  // explicit projectId so resolution does not depend on a path; no work_dir/repo for cwd.
  await launchAgentForBead(
    { launcher, recordLinkage: recorder().fn },
    bead({ 'gc.provider': 'claude', 'ghostex.projectId': 'P1xyz' }),
  );
  assert.deepEqual(launcher.createCalls, [{ projectId: 'P1xyz', agentId: 'claude' }]);
});
