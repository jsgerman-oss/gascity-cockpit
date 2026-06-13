/**
 * Bidirectional session/activity state sync between gas-city and Ghostex — the
 * `vscode`-free core that lets the Cockpit show one consistent view of an agent
 * whether you read it from the gas-city Fleet pane or the Ghostex Sessions
 * explorer.
 *
 * Two control planes describe overlapping reality with different vocabularies:
 *
 *   - **gas-city** (`/v0` status feed) speaks in the {@link GascitySessionLike}
 *     shape — a free-form `state` string, an `idle`/`in-turn` `activity`, and the
 *     `running`/`attached`/`suspended` booleans the supervisor owns.
 *   - **Ghostex** (the `/api/events` stream + `readPresentationSnapshot`) speaks
 *     in {@link GhostexPresentationSession} — a closed `activity`
 *     (`attention`/`working`/`idle`) and `lifecycleState`
 *     (`running`/`sleeping`/`stopped`/`missing`/`unknown`).
 *
 * This module is the translator and the reconciler. It is deliberately pure and
 * `vscode`-free (PRD "Seam 1"): the editor glue feeds it the two snapshots and
 * renders what it returns. Nothing here reaches a socket, a clock, or the
 * supervisor — the live wiring lives in the feature/view layer.
 *
 * Three jobs, mirroring the bead:
 *
 *   1. **gas-city → Ghostex** ({@link gascityFleetToGhostex}): reflect gas-city
 *      sessions/agents as Ghostex presentation rows, so the Sessions explorer can
 *      show the fleet alongside Ghostex's own sessions.
 *   2. **Ghostex → gas-city** ({@link ghostexSessionToFleetActivity}): fold
 *      Ghostex agent activity (attention/working/idle, completion) back into a
 *      fleet-shaped overlay the status panes can apply.
 *   3. **Reconcile** ({@link correlateFleetAndGhostex}): correlate the same
 *      logical session across both planes (by explicit link id, then by working
 *      directory) and resolve a single agreed activity + lifecycle, so a
 *      cross-hosted agent is shown once, consistently, not twice in conflict.
 *
 * The gas-city input types are *structural subsets* of the generated
 * `AgentResponse`/`SessionResponse`/`FleetSnapshot` (same field names), so a
 * caller passes those straight through with no adapter — and this core keeps no
 * dependency on `src/api` or `src/status`, matching the "local mirror, not an
 * import" stance of `./types.ts`.
 */
import type {
  GhostexLifecycleState,
  GhostexPresentationGroup,
  GhostexPresentationProject,
  GhostexPresentationSession,
  GhostexPresentationSnapshot,
  GhostexSessionActivity,
} from './types.ts';

// --- gas-city input shapes (structural subsets of the /v0 types) ------------

/**
 * The slice of a gas-city `SessionResponse` this core reads. A real
 * `SessionResponse` is assignable to it (same field names), so the status glue
 * passes sessions through unchanged.
 */
export interface GascitySessionLike {
  readonly id: string;
  readonly session_name: string;
  readonly template: string;
  readonly title: string;
  readonly state: string;
  readonly running: boolean;
  readonly attached: boolean;
  readonly created_at: string;
  readonly activity?: string;
  readonly agent_kind?: string;
  readonly display_name?: string;
  readonly active_bead?: string;
  readonly rig?: string;
  readonly pool?: string;
  readonly provider?: string;
  readonly last_active?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * The slice of a gas-city `AgentResponse` this core reads. Used to enrich a
 * session's projection (the agent owns `suspended`, and pairs to a session by
 * {@link GascityAgentLike.session}`.name`).
 */
export interface GascityAgentLike {
  readonly name: string;
  readonly state: string;
  readonly running: boolean;
  readonly suspended: boolean;
  readonly available: boolean;
  readonly activity?: string;
  readonly display_name?: string;
  readonly rig?: string;
  readonly session?: { readonly name: string } | undefined;
}

/**
 * The slice of a gas-city `FleetSnapshot` this core reads: agents and sessions
 * keyed by city name. A real `FleetSnapshot` is assignable to it.
 */
export interface GascityFleetLike {
  readonly agentsByCity: Readonly<Record<string, readonly GascityAgentLike[]>>;
  readonly sessionsByCity: Readonly<Record<string, readonly GascitySessionLike[]>>;
}

/** gas-city's coarse activity vocabulary (`SessionActivityEvent` + the attention case). */
export type GascityActivity = 'idle' | 'in-turn' | 'attention';

// --- Vocabulary normalisation -----------------------------------------------

/**
 * Fold a free-form gas-city `state`/`activity` token to a comparable form:
 * lowercased, trimmed, and with spaces/underscores unified to single hyphens
 * (`"In Turn"`, `"in_turn"`, and `"in-turn"` all become `"in-turn"`).
 */
function normToken(value: string | undefined): string {
  if (!value) return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

// The supervisor's `state` is free-form, so we recognise the families of tokens
// it (and the agents under it) actually emit rather than a single closed enum.
const ATTENTION_TOKENS = new Set([
  'attention',
  'blocked',
  'awaiting-input',
  'needs-input',
  'input-needed',
  'needs-attention',
  'prompt',
  'approval',
  'pending',
]);

const WORKING_TOKENS = new Set([
  'in-turn',
  'inturn',
  'working',
  'busy',
  'thinking',
  'streaming',
  'executing',
  'processing',
  'generating',
  'running-turn',
]);

const SLEEPING_TOKENS = new Set([
  'sleeping',
  'asleep',
  'suspended',
  'paused',
  'dormant',
  'hibernated',
]);

const STOPPED_TOKENS = new Set([
  'stopped',
  'exited',
  'dead',
  'killed',
  'done',
  'completed',
  'finished',
  'closed',
  'terminated',
  'ended',
  'shutdown',
]);

const MISSING_TOKENS = new Set([
  'missing',
  'gone',
  'lost',
  'orphan',
  'orphaned',
  'stranded',
  'unreachable',
  'disappeared',
]);

// --- gas-city → Ghostex vocabulary ------------------------------------------

/** The activity-bearing facets of a gas-city session/agent this mapping reads. */
export interface GascityActivityInput {
  readonly state?: string;
  readonly activity?: string;
  readonly running?: boolean;
  /** An explicit "operator action required" flag (e.g. a pending interaction). */
  readonly attention?: boolean;
}

/**
 * Map a gas-city session/agent's coarse activity onto Ghostex's closed
 * {@link GhostexSessionActivity}. Attention wins (a pending interaction or an
 * attention/blocked state); then an in-turn/working signal; otherwise idle. A
 * merely-`running` session with no work signal reads as **idle**, not working —
 * `running` is "the process is alive", not "mid-turn".
 */
export function gascityActivityToGhostex(input: GascityActivityInput): GhostexSessionActivity {
  if (input.attention) return 'attention';
  const act = normToken(input.activity);
  const st = normToken(input.state);
  if (ATTENTION_TOKENS.has(act) || ATTENTION_TOKENS.has(st)) return 'attention';
  if (WORKING_TOKENS.has(act) || WORKING_TOKENS.has(st)) return 'working';
  return 'idle';
}

/** The lifecycle-bearing facets of a gas-city session/agent this mapping reads. */
export interface GascityLifecycleInput {
  readonly state?: string;
  readonly running?: boolean;
  readonly suspended?: boolean;
}

/**
 * Map a gas-city session/agent's liveness onto Ghostex's
 * {@link GhostexLifecycleState}. A `suspended` agent (or an explicitly
 * asleep/paused state) is `sleeping`; an explicit terminal state is `stopped`;
 * an explicit lost state is `missing`; otherwise `running` follows the boolean,
 * and a non-running session with no telling state is `unknown` (we don't assert
 * `stopped` without evidence).
 */
export function gascityLifecycleToGhostex(input: GascityLifecycleInput): GhostexLifecycleState {
  const st = normToken(input.state);
  if (input.suspended || SLEEPING_TOKENS.has(st)) return 'sleeping';
  if (STOPPED_TOKENS.has(st)) return 'stopped';
  if (MISSING_TOKENS.has(st)) return 'missing';
  if (input.running) return 'running';
  return 'unknown';
}

// --- Ghostex → gas-city vocabulary ------------------------------------------

/** Map Ghostex's activity back to gas-city's coarse {@link GascityActivity}. */
export function ghostexActivityToGascity(activity: GhostexSessionActivity): GascityActivity {
  switch (activity) {
    case 'working':
      return 'in-turn';
    case 'attention':
      return 'attention';
    case 'idle':
    default:
      return 'idle';
  }
}

/** The fleet-shaped liveness a Ghostex lifecycle projects to. */
export interface GascityLiveness {
  readonly running: boolean;
  readonly state: string;
}

/** Map a Ghostex {@link GhostexLifecycleState} back to gas-city's running/state pair. */
export function ghostexLifecycleToGascity(lifecycle: GhostexLifecycleState): GascityLiveness {
  switch (lifecycle) {
    case 'running':
      return { running: true, state: 'running' };
    case 'sleeping':
      return { running: false, state: 'sleeping' };
    case 'stopped':
      return { running: false, state: 'stopped' };
    case 'missing':
      return { running: false, state: 'missing' };
    case 'unknown':
    default:
      return { running: false, state: 'unknown' };
  }
}

// --- Completion -------------------------------------------------------------

/** A point at which an agent's work concluded — its whole run, or one turn. */
export interface CompletionSignal {
  /** `ended` — the agent's runtime stopped; `turn` — it finished a turn and went idle. */
  readonly kind: 'ended' | 'turn';
}

/** The activity + lifecycle pair completion is derived from. */
export interface SessionStateSnapshot {
  readonly activity: GhostexSessionActivity;
  readonly lifecycleState: GhostexLifecycleState;
}

/**
 * Whether an agent session has reached terminal completion: an agent-kind
 * session whose lifecycle is `stopped`. Terminal-only — a turn boundary is a
 * transition, see {@link detectCompletion}.
 */
export function isAgentCompleted(session: {
  readonly kind?: string;
  readonly lifecycleState: GhostexLifecycleState;
}): boolean {
  const isAgent = session.kind === undefined || session.kind === 'agent';
  return isAgent && session.lifecycleState === 'stopped';
}

/**
 * Detect a completion event between two successive states of the same session.
 * Returns `ended` when the runtime stops, `turn` when a running agent leaves
 * `working` for `idle` (a finished turn), or `null` when nothing concluded. The
 * caller holds the prior state; this core stays snapshot-pure.
 */
export function detectCompletion(
  prev: SessionStateSnapshot,
  next: SessionStateSnapshot,
): CompletionSignal | null {
  if (prev.lifecycleState !== 'stopped' && next.lifecycleState === 'stopped') {
    return { kind: 'ended' };
  }
  if (next.lifecycleState === 'running' && prev.activity === 'working' && next.activity === 'idle') {
    return { kind: 'turn' };
  }
  return null;
}

// --- Shared options ---------------------------------------------------------

/** Default session metadata keys that carry the working-directory / worktree path. */
export const DEFAULT_CWD_KEYS = ['work_dir', 'cwd', 'worktree', 'workdir'] as const;

/** Default session metadata keys that carry an explicit Ghostex session-id link. */
export const DEFAULT_LINK_KEYS = [
  'ghostex.sessionId',
  'ghostexSessionId',
  'ghostex_session_id',
  'ghostex.session',
] as const;

/** How a gas-city session names the Ghostex session it is hosted in / mirrored by. */
export interface CorrelationKeyOptions {
  /** Metadata keys to read a working-directory from (default {@link DEFAULT_CWD_KEYS}). */
  readonly cwdKeys?: readonly string[];
  /** Metadata keys to read an explicit Ghostex session id from (default {@link DEFAULT_LINK_KEYS}). */
  readonly linkKeys?: readonly string[];
}

/** Normalise a filesystem path for comparison: trimmed, trailing slashes dropped. */
export function normalizeCwd(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const trimmed = path.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstMetadataValue(
  metadata: Readonly<Record<string, string>> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** The session's working directory, from the first populated cwd metadata key. */
export function gascitySessionCwd(
  session: GascitySessionLike,
  options?: CorrelationKeyOptions,
): string | undefined {
  return normalizeCwd(firstMetadataValue(session.metadata, options?.cwdKeys ?? DEFAULT_CWD_KEYS));
}

/** The explicit Ghostex session id the gas-city session links to, if any. */
export function gascitySessionLink(
  session: GascitySessionLike,
  options?: CorrelationKeyOptions,
): string | undefined {
  return firstMetadataValue(session.metadata, options?.linkKeys ?? DEFAULT_LINK_KEYS);
}

// --- Direction A: gas-city → Ghostex presentation rows ----------------------

/** Options for projecting gas-city fleet state into Ghostex presentation rows. */
export interface GascityToGhostexOptions extends CorrelationKeyOptions {
  /**
   * Namespace prefix for the synthesised ids, so a projected row never collides
   * with a real gxserver id. Default `gascity`.
   */
  readonly idPrefix?: string;
}

const DEFAULT_ID_PREFIX = 'gascity';

function projectId(prefix: string, cityName: string): string {
  return `${prefix}:project:${cityName}`;
}

function groupId(prefix: string, cityName: string, rig: string): string {
  return `${prefix}:group:${cityName}:${rig}`;
}

function sessionId(prefix: string, cityName: string, id: string): string {
  return `${prefix}:session:${cityName}:${id}`;
}

/**
 * Project one gas-city session (optionally enriched by its owning agent) into a
 * {@link GhostexPresentationSession} — the row the Ghostex explorer renders.
 * Ids are namespaced under `idPrefix` so the synthesised rows can be merged into
 * a real snapshot without collision.
 */
export function projectGascitySessionToGhostex(
  session: GascitySessionLike,
  context: {
    readonly cityName: string;
    readonly agent?: GascityAgentLike;
    readonly options?: GascityToGhostexOptions;
  },
): GhostexPresentationSession {
  const { cityName, agent, options } = context;
  const prefix = options?.idPrefix ?? DEFAULT_ID_PREFIX;
  const rig = session.rig ?? 'fleet';
  const activity = gascityActivityToGhostex({
    state: session.state,
    activity: session.activity ?? agent?.activity,
    running: session.running,
  });
  const lifecycleState = gascityLifecycleToGhostex({
    state: session.state,
    running: session.running,
    suspended: agent?.suspended,
  });
  const cwd = gascitySessionCwd(session, options);
  const agentId = session.template || agent?.name || session.agent_kind;
  const agentName = session.display_name ?? agent?.display_name;
  const projected: GhostexPresentationSession = {
    sessionId: sessionId(prefix, cityName, session.id),
    projectId: projectId(prefix, cityName),
    groupId: groupId(prefix, cityName, rig),
    title: session.title || session.session_name || session.id,
    kind: 'agent',
    activity,
    lifecycleState,
    surface: 'workspace',
    isFavorite: false,
    isPinned: false,
    sortKey: session.session_name || session.id,
    createdAt: session.created_at,
    updatedAt: session.last_active ?? session.created_at,
  };
  return {
    ...projected,
    ...(agentId ? { agentId } : {}),
    ...(agentName ? { agentName } : {}),
    ...(cwd ? { cwd } : {}),
    ...(session.active_bead ? { subtitle: session.active_bead } : {}),
  };
}

/**
 * Project a whole gas-city fleet into a {@link GhostexPresentationSnapshot}: one
 * project per city, one group per rig within it, and one session per gas-city
 * session (enriched by the agent that owns it, paired on session name). The
 * result is shaped exactly like a gxserver snapshot, so the Ghostex explorer
 * model can `seed()` it (or a merge of it with the real one) directly.
 */
export function gascityFleetToGhostex(
  fleet: GascityFleetLike,
  options?: GascityToGhostexOptions,
): GhostexPresentationSnapshot {
  const prefix = options?.idPrefix ?? DEFAULT_ID_PREFIX;
  const projects: GhostexPresentationProject[] = [];
  const groups: GhostexPresentationGroup[] = [];
  const sessions: GhostexPresentationSession[] = [];

  const cityNames = Object.keys(fleet.sessionsByCity).sort();
  for (const cityName of cityNames) {
    const citySessions = fleet.sessionsByCity[cityName];
    if (citySessions.length === 0) continue;

    const agentBySession = indexAgentsBySession(fleet.agentsByCity[cityName] ?? []);
    projects.push({
      projectId: projectId(prefix, cityName),
      title: cityName,
      isFavorite: false,
      isPinned: false,
      sortKey: cityName,
    });

    const groupBuckets = new Map<string, { rig: string; sessionIds: string[] }>();
    for (const session of citySessions) {
      const agent = agentBySession.get(session.session_name);
      const row = projectGascitySessionToGhostex(session, { cityName, agent, options });
      sessions.push(row);
      const bucket = groupBuckets.get(row.groupId);
      if (bucket) bucket.sessionIds.push(row.sessionId);
      else groupBuckets.set(row.groupId, { rig: session.rig ?? 'fleet', sessionIds: [row.sessionId] });
    }

    for (const [gid, bucket] of groupBuckets) {
      groups.push({
        groupId: gid,
        projectId: projectId(prefix, cityName),
        title: bucket.rig,
        sessionIds: bucket.sessionIds,
        sortKey: gid,
      });
    }
  }

  return { revision: 0, generatedAt: '', projects, groups, sessions };
}

function indexAgentsBySession(
  agents: readonly GascityAgentLike[],
): Map<string, GascityAgentLike> {
  const index = new Map<string, GascityAgentLike>();
  for (const agent of agents) {
    const name = agent.session?.name;
    if (name && !index.has(name)) index.set(name, agent);
  }
  return index;
}

// --- Direction B: Ghostex → gas-city fleet activity overlay -----------------

/**
 * Ghostex agent activity folded into the fleet's vocabulary — an overlay the
 * status panes can apply to the matching `AgentResponse`/`SessionResponse` (by
 * {@link FleetActivityOverlay.cwd} / {@link FleetActivityOverlay.agentId}) so a
 * Ghostex-hosted agent reads the same in the Fleet pane as in the Sessions tree.
 */
export interface FleetActivityOverlay {
  readonly ghostexSessionId: string;
  readonly activity: GascityActivity;
  readonly running: boolean;
  readonly state: string;
  readonly lifecycleState: GhostexLifecycleState;
  /** True when the session wants operator action (`activity === 'attention'`). */
  readonly attention: boolean;
  /** True when an agent session has reached terminal completion. */
  readonly completed: boolean;
  readonly cwd?: string;
  readonly agentId?: string;
}

/** Fold one Ghostex session's activity + lifecycle into a {@link FleetActivityOverlay}. */
export function ghostexSessionToFleetActivity(
  session: GhostexPresentationSession,
): FleetActivityOverlay {
  const liveness = ghostexLifecycleToGascity(session.lifecycleState);
  const overlay: FleetActivityOverlay = {
    ghostexSessionId: session.sessionId,
    activity: ghostexActivityToGascity(session.activity),
    running: liveness.running,
    state: liveness.state,
    lifecycleState: session.lifecycleState,
    attention: session.activity === 'attention',
    completed: isAgentCompleted(session),
  };
  return {
    ...overlay,
    ...(session.cwd ? { cwd: normalizeCwd(session.cwd) } : {}),
    ...(session.agentId ? { agentId: session.agentId } : {}),
  };
}

// --- Reconcile: correlate the two planes ------------------------------------

/**
 * Which plane wins each reconciled field. Defaults: **activity** follows Ghostex
 * (the finer-grained observation — it alone can say `attention`), **lifecycle**
 * follows gas-city (the supervisor owns the process: suspended/draining/running).
 */
export interface ReconcilePolicy {
  readonly activity: 'ghostex' | 'gascity';
  readonly lifecycle: 'ghostex' | 'gascity';
}

export const DEFAULT_RECONCILE_POLICY: ReconcilePolicy = {
  activity: 'ghostex',
  lifecycle: 'gascity',
};

/** How a {@link BridgedSession} was correlated across the two planes. */
export type BridgeVia = 'link' | 'cwd';

/** One logical session seen on both planes, with a single reconciled state. */
export interface BridgedSession {
  /** The value the two sides matched on (a Ghostex session id, or a cwd). */
  readonly key: string;
  readonly via: BridgeVia;
  readonly cityName: string;
  readonly gascitySession: GascitySessionLike;
  readonly ghostexSession: GhostexPresentationSession;
  /** Reconciled activity, per {@link ReconcilePolicy}. */
  readonly activity: GhostexSessionActivity;
  /** Reconciled lifecycle, per {@link ReconcilePolicy}. */
  readonly lifecycleState: GhostexLifecycleState;
  /** Whether the reconciled state is a completed agent run. */
  readonly completed: boolean;
}

/** A gas-city session with no Ghostex counterpart, tagged with its city. */
export interface GascityOnlySession {
  readonly cityName: string;
  readonly session: GascitySessionLike;
}

/**
 * The reconciled cross-plane view: sessions seen on both planes (with one agreed
 * state), plus the leftovers each plane holds alone. This is the single shape
 * both panes read from to stay consistent.
 */
export interface BridgeResult {
  readonly bridged: readonly BridgedSession[];
  readonly gascityOnly: readonly GascityOnlySession[];
  readonly ghostexOnly: readonly GhostexPresentationSession[];
}

/** Options for {@link correlateFleetAndGhostex}. */
export interface BridgeOptions extends GascityToGhostexOptions {
  readonly policy?: ReconcilePolicy;
}

/**
 * Resolve the agreed activity + lifecycle for a session present on both planes.
 * Exported for direct testing of the policy.
 */
export function reconcile(
  gascitySession: GascitySessionLike,
  ghostexSession: GhostexPresentationSession,
  policy: ReconcilePolicy = DEFAULT_RECONCILE_POLICY,
  agent?: GascityAgentLike,
): { activity: GhostexSessionActivity; lifecycleState: GhostexLifecycleState; completed: boolean } {
  const gascityActivity = gascityActivityToGhostex({
    state: gascitySession.state,
    activity: gascitySession.activity ?? agent?.activity,
    running: gascitySession.running,
  });
  const gascityLifecycle = gascityLifecycleToGhostex({
    state: gascitySession.state,
    running: gascitySession.running,
    suspended: agent?.suspended,
  });
  const activity = policy.activity === 'gascity' ? gascityActivity : ghostexSession.activity;
  const lifecycleState =
    policy.lifecycle === 'ghostex' ? ghostexSession.lifecycleState : gascityLifecycle;
  return {
    activity,
    lifecycleState,
    completed: isAgentCompleted({ kind: ghostexSession.kind, lifecycleState }),
  };
}

/**
 * Correlate gas-city fleet state with the live Ghostex sessions and resolve a
 * single consistent view.
 *
 * Matching is conservative — we never guess from titles. A gas-city session
 * binds to a Ghostex session by, in order:
 *
 *   1. an **explicit link** — a metadata key (default {@link DEFAULT_LINK_KEYS})
 *      holding the Ghostex session id, the authoritative signal the drive/launch
 *      bridge writes when it hosts an agent;
 *   2. its **working directory** — the session's cwd metadata (default
 *      {@link DEFAULT_CWD_KEYS}) equal to a Ghostex session's `cwd`.
 *
 * Each Ghostex session binds at most once (the first gas-city claimant wins, in
 * city-then-array order). Unmatched rows fall through to `gascityOnly` /
 * `ghostexOnly`, so the caller can still surface both planes in full.
 */
export function correlateFleetAndGhostex(
  fleet: GascityFleetLike,
  ghostexSessions: readonly GhostexPresentationSession[],
  options?: BridgeOptions,
): BridgeResult {
  const policy = options?.policy ?? DEFAULT_RECONCILE_POLICY;
  const byId = new Map<string, GhostexPresentationSession>();
  const byCwd = new Map<string, GhostexPresentationSession>();
  for (const session of ghostexSessions) {
    if (!byId.has(session.sessionId)) byId.set(session.sessionId, session);
    const cwd = normalizeCwd(session.cwd);
    if (cwd && !byCwd.has(cwd)) byCwd.set(cwd, session);
  }

  const used = new Set<string>();
  const bridged: BridgedSession[] = [];
  const gascityOnly: GascityOnlySession[] = [];

  for (const cityName of Object.keys(fleet.sessionsByCity).sort()) {
    const citySessions = fleet.sessionsByCity[cityName];
    const agentBySession = indexAgentsBySession(fleet.agentsByCity[cityName] ?? []);
    for (const session of citySessions) {
      const match = matchGhostex(session, byId, byCwd, used, options);
      if (!match) {
        gascityOnly.push({ cityName, session });
        continue;
      }
      used.add(match.session.sessionId);
      const agent = agentBySession.get(session.session_name);
      const resolved = reconcile(session, match.session, policy, agent);
      bridged.push({
        key: match.key,
        via: match.via,
        cityName,
        gascitySession: session,
        ghostexSession: match.session,
        activity: resolved.activity,
        lifecycleState: resolved.lifecycleState,
        completed: resolved.completed,
      });
    }
  }

  const ghostexOnly = ghostexSessions.filter((session) => !used.has(session.sessionId));
  return { bridged, gascityOnly, ghostexOnly };
}

interface GhostexMatch {
  readonly session: GhostexPresentationSession;
  readonly via: BridgeVia;
  readonly key: string;
}

function matchGhostex(
  session: GascitySessionLike,
  byId: ReadonlyMap<string, GhostexPresentationSession>,
  byCwd: ReadonlyMap<string, GhostexPresentationSession>,
  used: ReadonlySet<string>,
  options?: CorrelationKeyOptions,
): GhostexMatch | null {
  const link = gascitySessionLink(session, options);
  if (link) {
    const candidate = byId.get(link);
    if (candidate && !used.has(candidate.sessionId)) {
      return { session: candidate, via: 'link', key: link };
    }
  }
  const cwd = gascitySessionCwd(session, options);
  if (cwd) {
    const candidate = byCwd.get(cwd);
    if (candidate && !used.has(candidate.sessionId)) {
      return { session: candidate, via: 'cwd', key: cwd };
    }
  }
  return null;
}
