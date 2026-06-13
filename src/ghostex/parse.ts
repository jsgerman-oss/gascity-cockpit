/**
 * Pure, `vscode`-free narrowing helpers: project loosely-typed gxserver JSON
 * (from either the `gx --json` CLI or the gxserver RPC) onto the local domain
 * types in {@link ./types.ts}. Tolerant by design — gxserver may add fields, and
 * the CLI and RPC shapes overlap but are not identical — but strict about the
 * handful of fields the Cockpit relies on. No `any`: everything funnels through
 * `unknown` guards.
 */

import type {
  GhostexBoardItem,
  GhostexHealth,
  GhostexPresentationGroup,
  GhostexPresentationProject,
  GhostexPresentationSession,
  GhostexPresentationSnapshot,
  GhostexProject,
  GhostexServerHealth,
  GhostexSession,
  GhostexSessionActivity,
  GhostexSessionKind,
  GhostexSessionLifecycleResult,
  GhostexLifecycleState,
  GhostexSessionSurface,
  GhostexTypedOperationResult,
  GhostexWorktreeEntry,
} from './types.ts';

/** Raised when a payload is structurally not what an endpoint promised. */
export class GhostexParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhostexParseError';
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function reqStr(rec: Record<string, unknown>, key: string, ctx: string): string {
  const v = rec[key];
  if (typeof v !== 'string') {
    throw new GhostexParseError(`${ctx}: expected string "${key}", got ${describe(v)}`);
  }
  return v;
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Parse arbitrary JSON text, raising a {@link GhostexParseError} on failure. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new GhostexParseError(`invalid JSON: ${(err as Error).message}`);
  }
}

const SESSION_KINDS = new Set<GhostexSessionKind>(['terminal', 'agent']);
const LIFECYCLE_STATES = new Set<GhostexLifecycleState>([
  'running',
  'sleeping',
  'stopped',
  'missing',
  'unknown',
]);
const ACTIVITIES = new Set<GhostexSessionActivity>(['attention', 'idle', 'working']);
const SURFACES = new Set<GhostexSessionSurface>(['workspace', 'commands']);

function asKind(v: unknown): GhostexSessionKind {
  return typeof v === 'string' && SESSION_KINDS.has(v as GhostexSessionKind)
    ? (v as GhostexSessionKind)
    : 'terminal';
}

function asLifecycle(v: unknown): GhostexLifecycleState {
  return typeof v === 'string' && LIFECYCLE_STATES.has(v as GhostexLifecycleState)
    ? (v as GhostexLifecycleState)
    : 'unknown';
}

function asActivity(v: unknown): GhostexSessionActivity {
  return typeof v === 'string' && ACTIVITIES.has(v as GhostexSessionActivity)
    ? (v as GhostexSessionActivity)
    : 'idle';
}

function asSurface(v: unknown): GhostexSessionSurface {
  return typeof v === 'string' && SURFACES.has(v as GhostexSessionSurface)
    ? (v as GhostexSessionSurface)
    : 'workspace';
}

/** Project one session record (domain-state shape) onto {@link GhostexSession}. */
export function parseSession(raw: unknown): GhostexSession {
  if (!isRecord(raw)) {
    throw new GhostexParseError(`session: expected object, got ${describe(raw)}`);
  }
  const sessionId = reqStr(raw, 'sessionId', 'session');
  const projectId = reqStr(raw, 'projectId', 'session');
  return {
    sessionId,
    projectId,
    globalRef: str(raw['globalRef']) ?? `${projectId}:${sessionId}`,
    kind: asKind(raw['kind']),
    title: str(raw['title']) ?? '',
    lifecycleState: asLifecycle(raw['lifecycleState']),
    surface: asSurface(raw['surface']),
    ...(str(raw['agentId']) ? { agentId: str(raw['agentId']) } : {}),
    ...(str(raw['cwd']) ? { cwd: str(raw['cwd']) } : {}),
    isFavorite: boolOr(raw['isFavorite'], false),
    isPinned: boolOr(raw['isPinned'], false),
    createdAt: str(raw['createdAt']) ?? '',
    updatedAt: str(raw['updatedAt']) ?? '',
    ...(str(raw['lastActiveAt']) ? { lastActiveAt: str(raw['lastActiveAt']) } : {}),
  };
}

/** Project a list of sessions, tolerating a bare array or `{ sessions: [...] }`. */
export function parseSessionList(raw: unknown): GhostexSession[] {
  const arr = pickArray(raw, 'sessions');
  return arr.map(parseSession);
}

/** Project one project record onto {@link GhostexProject}. */
export function parseProject(raw: unknown): GhostexProject {
  if (!isRecord(raw)) {
    throw new GhostexParseError(`project: expected object, got ${describe(raw)}`);
  }
  return {
    projectId: reqStr(raw, 'projectId', 'project'),
    name: str(raw['name']) ?? '',
    ...(str(raw['path']) ? { path: str(raw['path']) } : {}),
    isFavorite: boolOr(raw['isFavorite'], false),
    isPinned: boolOr(raw['isPinned'], false),
    createdAt: str(raw['createdAt']) ?? '',
    updatedAt: str(raw['updatedAt']) ?? '',
  };
}

export function parseProjectList(raw: unknown): GhostexProject[] {
  return pickArray(raw, 'projects').map(parseProject);
}

/** Project a lifecycle endpoint result (`{ session }`). */
export function parseLifecycleResult(raw: unknown): GhostexSessionLifecycleResult {
  if (!isRecord(raw)) {
    throw new GhostexParseError(`lifecycle result: expected object, got ${describe(raw)}`);
  }
  return { session: parseSession(raw['session']) };
}

/**
 * Pull the session text out of a `readSessionText` result. gxserver returns it
 * under `text`; the CLI may surface it under `text` or `stdout`.
 */
export function parseSessionText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (isRecord(raw)) {
    return str(raw['text']) ?? str(raw['stdout']) ?? '';
  }
  throw new GhostexParseError(`session text: expected object or string, got ${describe(raw)}`);
}

function parsePresentationProject(raw: unknown): GhostexPresentationProject {
  if (!isRecord(raw)) {
    throw new GhostexParseError(`presentation project: expected object, got ${describe(raw)}`);
  }
  return {
    projectId: reqStr(raw, 'projectId', 'presentation project'),
    title: str(raw['title']) ?? '',
    ...(str(raw['path']) ? { path: str(raw['path']) } : {}),
    isFavorite: boolOr(raw['isFavorite'], false),
    isPinned: boolOr(raw['isPinned'], false),
    sortKey: str(raw['sortKey']) ?? '',
  };
}

function parsePresentationGroup(raw: unknown): GhostexPresentationGroup {
  if (!isRecord(raw)) {
    throw new GhostexParseError(`presentation group: expected object, got ${describe(raw)}`);
  }
  const sessionIds = Array.isArray(raw['sessionIds'])
    ? raw['sessionIds'].filter((s): s is string => typeof s === 'string')
    : [];
  return {
    groupId: reqStr(raw, 'groupId', 'presentation group'),
    projectId: reqStr(raw, 'projectId', 'presentation group'),
    title: str(raw['title']) ?? '',
    sessionIds,
    sortKey: str(raw['sortKey']) ?? '',
  };
}

/** Project one presentation-session row (exported: the events stream reuses it). */
export function parsePresentationSession(raw: unknown): GhostexPresentationSession {
  if (!isRecord(raw)) {
    throw new GhostexParseError(`presentation session: expected object, got ${describe(raw)}`);
  }
  return {
    sessionId: reqStr(raw, 'sessionId', 'presentation session'),
    projectId: reqStr(raw, 'projectId', 'presentation session'),
    groupId: str(raw['groupId']) ?? '',
    title: str(raw['title']) ?? '',
    kind: asKind(raw['kind']),
    activity: asActivity(raw['activity']),
    lifecycleState: asLifecycle(raw['lifecycleState']),
    surface: asSurface(raw['surface']),
    ...(str(raw['agentId']) ? { agentId: str(raw['agentId']) } : {}),
    ...(str(raw['agentName']) ? { agentName: str(raw['agentName']) } : {}),
    ...(str(raw['cwd']) ? { cwd: str(raw['cwd']) } : {}),
    isFavorite: boolOr(raw['isFavorite'], false),
    isPinned: boolOr(raw['isPinned'], false),
    sortKey: str(raw['sortKey']) ?? '',
    ...(str(raw['subtitle']) ? { subtitle: str(raw['subtitle']) } : {}),
    createdAt: str(raw['createdAt']) ?? '',
    updatedAt: str(raw['updatedAt']) ?? '',
  };
}

/** Project a full presentation snapshot. */
export function parsePresentationSnapshot(raw: unknown): GhostexPresentationSnapshot {
  // Both `{ snapshot: {...} }` (event/RPC envelope) and a bare snapshot are accepted.
  const root = isRecord(raw) && isRecord(raw['snapshot']) ? raw['snapshot'] : raw;
  if (!isRecord(root)) {
    throw new GhostexParseError(`presentation snapshot: expected object, got ${describe(root)}`);
  }
  return {
    revision: numOr(root['revision'], 0),
    generatedAt: str(root['generatedAt']) ?? '',
    projects: arrOf(root['projects']).map(parsePresentationProject),
    groups: arrOf(root['groups']).map(parsePresentationGroup),
    sessions: arrOf(root['sessions']).map(parsePresentationSession),
  };
}

/** Project a typed git/worktree/beads operation result. */
export function parseTypedOperationResult(raw: unknown): GhostexTypedOperationResult {
  if (!isRecord(raw)) {
    throw new GhostexParseError(`typed operation: expected object, got ${describe(raw)}`);
  }
  const worktrees = Array.isArray(raw['worktrees'])
    ? raw['worktrees'].map(parseWorktreeEntry)
    : undefined;
  return {
    action: str(raw['action']) ?? '',
    exitCode: numOr(raw['exitCode'], 0),
    stdout: str(raw['stdout']) ?? '',
    stderr: str(raw['stderr']) ?? '',
    ...(worktrees ? { worktrees } : {}),
  };
}

function parseWorktreeEntry(raw: unknown): GhostexWorktreeEntry {
  if (!isRecord(raw)) {
    throw new GhostexParseError(`worktree entry: expected object, got ${describe(raw)}`);
  }
  return {
    path: str(raw['path']) ?? '',
    branch: str(raw['branch']) ?? '',
    bare: boolOr(raw['bare'], false),
    detached: boolOr(raw['detached'], false),
  };
}

/** Project a beads `board` result into board items. */
export function parseBoardItems(raw: unknown): GhostexBoardItem[] {
  const issues = isRecord(raw) && Array.isArray(raw['issues']) ? raw['issues'] : pickArray(raw, 'issues');
  return issues.filter(isRecord).map((rec): GhostexBoardItem => ({
    id: str(rec['id']) ?? str(rec['issueId']) ?? '',
    title: str(rec['title']) ?? '',
    ...(str(rec['status']) ? { status: str(rec['status']) } : {}),
    ...(str(rec['priority']) ? { priority: str(rec['priority']) } : {}),
    raw: rec,
  }));
}

/** Parse the minimal `/api/health` body. */
export function parseHealth(raw: unknown): GhostexHealth {
  if (!isRecord(raw)) {
    throw new GhostexParseError(`health: expected object, got ${describe(raw)}`);
  }
  return {
    ok: boolOr(raw['ok'], false),
    product: str(raw['product']) ?? '',
    protocolVersion: numOr(raw['protocolVersion'], 0),
    version: str(raw['version']) ?? 'unknown',
  };
}

/** Parse the detailed `/api/health/server` body. */
export function parseServerHealth(raw: unknown): GhostexServerHealth {
  const base = parseHealth(raw);
  const rec = raw as Record<string, unknown>;
  const capabilities = Array.isArray(rec['capabilities'])
    ? rec['capabilities'].filter((c): c is string => typeof c === 'string')
    : [];
  return {
    ...base,
    serverId: str(rec['serverId']) ?? '',
    buildIdentity: str(rec['buildIdentity']) ?? '',
    pid: numOr(rec['pid'], 0),
    port: numOr(rec['port'], 0),
    startedAt: str(rec['startedAt']) ?? '',
    capabilities,
  };
}

/** Coerce `unknown` into an array, or empty when it is not one. */
function arrOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Accept either a bare array or an object wrapping the array under `key`
 * (covering both the CLI's `[...]` and the RPC's `{ sessions: [...] }` shapes).
 */
function pickArray(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw[key])) return raw[key] as unknown[];
  throw new GhostexParseError(`expected an array or { ${key}: [...] }, got ${describe(raw)}`);
}
