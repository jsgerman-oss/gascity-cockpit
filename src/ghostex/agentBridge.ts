/**
 * The agents-bridge core: turn a gas-city bead/dispatch into an agent launched
 * *into a Ghostex pane*, and record the bead ↔ Ghostex session linkage so the
 * operator can reveal/attach that session later.
 *
 * The contract (bead `zmux-ecb31720`): given a gas-city bead, launch the agent
 * via `gx create-agent` — `agentId` (claude/codex), the Ghostex `project`, and
 * the `cwd` all derived from the bead's metadata (its worktree) — then persist
 * the linkage keyed by the session's global ref `S:P:G`.
 *
 * Like the rest of `src/ghostex/`, this module is `vscode`-free and side-effect
 * free: the Ghostex calls and the metadata write are injected (a
 * {@link AgentLauncher} and a {@link LinkageRecorder}), so it is unit-tested in
 * plain Node with fakes — no `gx` binary, no live gxserver, no supervisor. The
 * thin editor glue that wires the real client + the /v0 bead-metadata writer
 * lives in `src/views/ghostexAgentBridge.ts` (PRD "Seam 1").
 *
 * Nothing here throws for an expected failure: every entry point returns a typed
 * outcome with an actionable `detail`, mirroring `GhostexDiscovery` / `BeadResult`.
 */

import type { GhostexProject, GhostexSession } from './types.ts';

/** A bead, reduced to the fields the bridge reads (matches the /v0 `Bead`). */
export interface BeadLike {
  readonly id: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * A resolved launch request, derived from a bead. `agentId` is the only hard
 * requirement; `cwd` and the project hints are best-effort (resolved/threaded
 * when present).
 */
export interface AgentLaunchRequest {
  readonly beadId: string;
  /** The agent to launch (e.g. `claude`, `codex`). */
  readonly agentId: string;
  /** Working directory for the session — the bead's worktree, threaded to create-agent. */
  readonly cwd?: string;
  /** Repo/worktree path used to resolve the Ghostex project (the bead's `repo`/`work_dir`). */
  readonly projectMatch?: string;
  /** Explicit Ghostex projectId override (`ghostex.projectId`), bypassing path resolution. */
  readonly explicitProjectId?: string;
}

/** The bead ↔ Ghostex session linkage. `globalRef` is the canonical `S:P:G` key. */
export interface AgentLinkage {
  readonly beadId: string;
  readonly sessionId: string;
  /** Ghostex global reference `S<n>:P<n>…:G<n>…`. */
  readonly globalRef: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly cwd?: string;
}

/** Bead-metadata keys the linkage is stored under (namespaced to avoid clashes). */
export const LINKAGE_KEYS = {
  globalRef: 'ghostex.globalRef',
  sessionId: 'ghostex.sessionId',
  projectId: 'ghostex.projectId',
  agentId: 'ghostex.agentId',
} as const;

/** The result of {@link deriveLaunchRequest}: a request, or why one can't be built. */
export type DeriveResult =
  | { readonly ok: true; readonly request: AgentLaunchRequest }
  | { readonly ok: false; readonly reason: 'missingAgent'; readonly detail: string };

/** The Ghostex surface the bridge drives — structurally satisfied by `GxClient`. */
export interface AgentLauncher {
  listProjects(): Promise<readonly GhostexProject[]>;
  createAgentSession(params: {
    projectId: string;
    agentId: string;
    cwd?: string;
  }): Promise<GhostexSession>;
}

/** Outcome of persisting the linkage (e.g. a /v0 bead-metadata update). */
export type LinkageRecordResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** Persist the linkage metadata onto the bead. Injected so the core stays I/O-free. */
export type LinkageRecorder = (
  beadId: string,
  metadata: Record<string, string>,
) => Promise<LinkageRecordResult>;

/** Why a launch could not happen at all (no side effects occurred). */
export type LaunchFailureReason = 'missingAgent' | 'noProject' | 'launchFailed';

/**
 * The outcome of {@link launchAgentForBead}.
 *
 * On `ok`, the agent session was created. `recorded` reports whether the linkage
 * was persisted — a created session whose linkage failed to save is still a
 * success (the agent is running), just flagged so the UI can warn. On failure,
 * no session was created.
 */
export type LaunchOutcome =
  | {
      readonly ok: true;
      readonly linkage: AgentLinkage;
      readonly session: GhostexSession;
      readonly recorded: boolean;
      /** Set when `recorded` is false: why the linkage could not be saved. */
      readonly recordError?: string;
    }
  | { readonly ok: false; readonly reason: LaunchFailureReason; readonly detail: string };

export interface LaunchDeps {
  readonly launcher: AgentLauncher;
  readonly recordLinkage: LinkageRecorder;
}

// --- Derivation -------------------------------------------------------------

/**
 * The agent id to launch, derived from bead metadata, in precedence order:
 *   1. `ghostex.agentId` — an explicit override.
 *   2. `gc.provider` — the dispatch provider (`claude` / `codex`).
 *   3. the head of `gc.run_target` (`claude-opus` → `claude`, `codex-gpt55` → `codex`).
 * Returns `undefined` when none is present.
 */
export function deriveAgentId(metadata: Readonly<Record<string, string>> | undefined): string | undefined {
  const explicit = clean(metadata?.['ghostex.agentId']);
  if (explicit) return explicit;
  const provider = clean(metadata?.['gc.provider']);
  if (provider) return provider;
  const runTarget = clean(metadata?.['gc.run_target']);
  if (runTarget) {
    const head = runTarget.split(/[-/]/)[0];
    if (head) return head;
  }
  return undefined;
}

/** The cwd to start the agent in: the bead's worktree (`work_dir`), else its `repo`. */
export function deriveCwd(metadata: Readonly<Record<string, string>> | undefined): string | undefined {
  return clean(metadata?.['work_dir']) ?? clean(metadata?.['repo']);
}

/** The path used to resolve the Ghostex project: the bead's `repo`, else its `work_dir`. */
export function deriveProjectMatch(
  metadata: Readonly<Record<string, string>> | undefined,
): string | undefined {
  return clean(metadata?.['repo']) ?? clean(metadata?.['work_dir']);
}

/** Build a launch request from a bead, or report why one cannot be built. */
export function deriveLaunchRequest(bead: BeadLike): DeriveResult {
  const md = bead.metadata;
  const agentId = deriveAgentId(md);
  if (!agentId) {
    return {
      ok: false,
      reason: 'missingAgent',
      detail: `bead ${bead.id} has no agent to launch — set gc.provider, gc.run_target, or ghostex.agentId`,
    };
  }
  const cwd = deriveCwd(md);
  const projectMatch = deriveProjectMatch(md);
  const explicitProjectId = clean(md?.['ghostex.projectId']);
  return {
    ok: true,
    request: {
      beadId: bead.id,
      agentId,
      ...(cwd ? { cwd } : {}),
      ...(projectMatch ? { projectMatch } : {}),
      ...(explicitProjectId ? { explicitProjectId } : {}),
    },
  };
}

// --- Project resolution -----------------------------------------------------

/**
 * Resolve the Ghostex project for a request by matching its `projectMatch` (the
 * repo) then its `cwd` against the projects' paths, in escalating tolerance:
 *   1. exact path equality,
 *   2. a project path that is an ancestor of the target (target lives inside it —
 *      covers worktrees nested under the repo),
 *   3. a basename match (the repo moved or is symlinked — last resort).
 * Returns `undefined` when nothing matches. Does not consider an explicit
 * projectId override — that is the orchestrator's policy (see {@link launchAgentForBead}).
 */
export function resolveProjectId(
  projects: readonly GhostexProject[],
  request: Pick<AgentLaunchRequest, 'projectMatch' | 'cwd'>,
): string | undefined {
  const targets = [request.projectMatch, request.cwd]
    .map((t) => clean(t))
    .filter((t): t is string => t !== undefined)
    .map(normPath);
  if (targets.length === 0) return undefined;

  // Normalize each project's path once so every comparison below is apples-to-apples.
  const candidates = projects
    .map((p) => ({ projectId: p.projectId, path: clean(p.path) }))
    .filter((p): p is { projectId: string; path: string } => p.path !== undefined)
    .map((p) => ({ projectId: p.projectId, path: normPath(p.path) }));

  for (const t of targets) {
    const exact = candidates.find((p) => p.path === t);
    if (exact) return exact.projectId;
  }
  for (const t of targets) {
    const ancestor = candidates.find((p) => isAncestorPath(p.path, t));
    if (ancestor) return ancestor.projectId;
  }
  for (const t of targets) {
    const base = basename(t);
    const byName = candidates.find((p) => basename(p.path) === base);
    if (byName) return byName.projectId;
  }
  return undefined;
}

// --- Linkage ----------------------------------------------------------------

/** The metadata patch persisting a linkage on its bead (all values are strings). */
export function linkageMetadata(linkage: AgentLinkage): Record<string, string> {
  return {
    [LINKAGE_KEYS.globalRef]: linkage.globalRef,
    [LINKAGE_KEYS.sessionId]: linkage.sessionId,
    [LINKAGE_KEYS.projectId]: linkage.projectId,
    [LINKAGE_KEYS.agentId]: linkage.agentId,
  };
}

/**
 * Read back a previously-recorded linkage from a bead's metadata, for the
 * reveal/attach-later path. Returns `null` when the bead carries no linkage.
 * Tolerates a linkage that recorded only the global ref: the session id is the
 * ref's trailing `G…` segment.
 */
export function readLinkage(bead: BeadLike): AgentLinkage | null {
  const md = bead.metadata;
  const sessionId = clean(md?.[LINKAGE_KEYS.sessionId]);
  const globalRef = clean(md?.[LINKAGE_KEYS.globalRef]);
  if (!sessionId && !globalRef) return null;
  const resolvedSessionId = sessionId ?? sessionIdFromRef(globalRef as string);
  if (!resolvedSessionId) return null;
  return {
    beadId: bead.id,
    sessionId: resolvedSessionId,
    globalRef: globalRef ?? resolvedSessionId,
    projectId: clean(md?.[LINKAGE_KEYS.projectId]) ?? '',
    agentId: clean(md?.[LINKAGE_KEYS.agentId]) ?? '',
  };
}

// --- Orchestration ----------------------------------------------------------

/**
 * Launch a gas-city bead's agent into a Ghostex pane and record the linkage.
 *
 * Derive the request → resolve the project (explicit override, else by path) →
 * `gx create-agent` in the bead's worktree → persist the `S:P:G` linkage on the
 * bead. Any expected failure short-circuits to a typed `{ ok: false }` with an
 * actionable detail; a created-but-unrecorded session still resolves `ok` with
 * `recorded: false`.
 */
export async function launchAgentForBead(deps: LaunchDeps, bead: BeadLike): Promise<LaunchOutcome> {
  const derived = deriveLaunchRequest(bead);
  if (!derived.ok) return { ok: false, reason: derived.reason, detail: derived.detail };
  const request = derived.request;

  let projectId = request.explicitProjectId;
  if (!projectId) {
    let projects: readonly GhostexProject[];
    try {
      projects = await deps.launcher.listProjects();
    } catch (err) {
      return { ok: false, reason: 'noProject', detail: `could not list Ghostex projects: ${errText(err)}` };
    }
    projectId = resolveProjectId(projects, request);
  }
  if (!projectId) {
    const hint = request.projectMatch ?? request.cwd ?? `bead ${request.beadId}`;
    return {
      ok: false,
      reason: 'noProject',
      detail: `no Ghostex project matches ${hint} — open it in Ghostex first, or set ghostex.projectId`,
    };
  }

  let session: GhostexSession;
  try {
    session = await deps.launcher.createAgentSession({
      projectId,
      agentId: request.agentId,
      ...(request.cwd ? { cwd: request.cwd } : {}),
    });
  } catch (err) {
    return { ok: false, reason: 'launchFailed', detail: `gx create-agent failed: ${errText(err)}` };
  }

  const linkage = buildLinkage(request.beadId, session, projectId, request.agentId);
  const record = await deps.recordLinkage(request.beadId, linkageMetadata(linkage));
  return record.ok
    ? { ok: true, linkage, session, recorded: true }
    : { ok: true, linkage, session, recorded: false, recordError: record.detail };
}

// --- Internals --------------------------------------------------------------

function buildLinkage(
  beadId: string,
  session: GhostexSession,
  projectId: string,
  agentId: string,
): AgentLinkage {
  return {
    beadId,
    sessionId: session.sessionId,
    globalRef: session.globalRef,
    projectId,
    agentId,
    ...(session.cwd ? { cwd: session.cwd } : {}),
  };
}

/** Trim a maybe-string; collapse empty/whitespace and non-strings to `undefined`. */
function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Drop trailing slashes (keeping a lone `/`). Inputs are pre-trimmed. */
function normPath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * Whether `child` is strictly inside directory `parent` (segment-aware, so
 * `/a/b` is not "inside" `/a/bc`). Both inputs are already normalized by the
 * caller; exact equality is handled separately, so this is the strict case only.
 */
function isAncestorPath(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

/** The last path segment of a normalized path. */
function basename(p: string): string {
  const n = normPath(p);
  const slash = n.lastIndexOf('/');
  return slash >= 0 ? n.slice(slash + 1) : n;
}

/** The session id encoded as the trailing `:`-segment of a global ref. */
function sessionIdFromRef(ref: string): string | undefined {
  const parts = ref.split(':');
  return clean(parts[parts.length - 1]);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
