/**
 * Local TypeScript types for the Ghostex domain the Cockpit drives.
 *
 * These are deliberately a *local* mirror of the `gxserver` wire protocol
 * (`~/.ghostex/gxserver/protocol`), not an import of it: the Cockpit lives in a
 * different repo and must not couple to Ghostex's build. We model only the
 * fields the Cockpit reads, keep the camelCase wire-field names the protocol
 * pins, and accept-but-ignore the rest (servers may send more). Like the rest of
 * `src/ghostex/`, this module is `vscode`-free so it is unit-testable in plain
 * Node (PRD "Seam 1").
 *
 * Field naming follows the gxserver protocol contract: JSON fields and endpoint
 * path tokens stay camelCase, and a protocol-version mismatch is a hard failure
 * (the daemon asks the user to update rather than falling back).
 */

/** Protocol version this client speaks; sent as `x-gxserver-protocol-version`. */
export const GXSERVER_PROTOCOL_VERSION = 1 as const;

/** The product identifier every gxserver response carries. */
export const GXSERVER_PRODUCT = 'gxserver' as const;

/** Default local gxserver base URL (host + port from the protocol constants). */
export const DEFAULT_GXSERVER_BASE_URL = 'http://127.0.0.1:58744';

/** Tilde-relative path of the local bearer-token file. */
export const DEFAULT_TOKEN_PATH = '~/.ghostex/gxserver/auth/token';

/** Branded id strings. Kept as plain `string` aliases so callers stay ergonomic. */
export type GhostexServerId = string;
export type GhostexProjectId = string;
export type GhostexSessionId = string;
/** Global reference `S<n>:P<n>xxx:G<n>xxx`. */
export type GhostexGlobalSessionRef = string;

/** A session is either a raw terminal or an agent-driven session. */
export type GhostexSessionKind = 'terminal' | 'agent';

/** Domain lifecycle of a session's provider-backed runtime. */
export type GhostexLifecycleState = 'running' | 'sleeping' | 'stopped' | 'missing' | 'unknown';

/** Coarse activity, derived by gxserver from title/agent observation. */
export type GhostexSessionActivity = 'attention' | 'idle' | 'working';

/** Where a session surfaces in the Ghostex UI. */
export type GhostexSessionSurface = 'workspace' | 'commands';

/**
 * A Ghostex session, as the Cockpit cares about it. A local projection of
 * `GxserverSessionDomainState` — only the fields the Cockpit reads, with the
 * opaque `Record<string, unknown>` bags dropped.
 */
export interface GhostexSession {
  readonly sessionId: GhostexSessionId;
  readonly projectId: GhostexProjectId;
  readonly globalRef: GhostexGlobalSessionRef;
  readonly kind: GhostexSessionKind;
  readonly title: string;
  readonly lifecycleState: GhostexLifecycleState;
  readonly surface: GhostexSessionSurface;
  /** Agent identifier (e.g. "claude") when `kind === "agent"`. */
  readonly agentId?: string;
  /** Working directory of the session, when known. */
  readonly cwd?: string;
  readonly isFavorite: boolean;
  readonly isPinned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActiveAt?: string;
}

/**
 * A Ghostex project. A local projection of `GxserverProjectDomainState` — the
 * identity/labelling fields, not the rules/settings bags.
 */
export interface GhostexProject {
  readonly projectId: GhostexProjectId;
  readonly name: string;
  readonly path?: string;
  readonly isFavorite: boolean;
  readonly isPinned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A board item (a bead) surfaced by `runBeadsAction({ action: "board" })`. */
export interface GhostexBoardItem {
  readonly id: string;
  readonly title: string;
  readonly status?: string;
  readonly priority?: string;
  /** Any further fields the board emits, kept verbatim for forward-compat. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Presentation-snapshot project row (UI-facing projection). */
export interface GhostexPresentationProject {
  readonly projectId: GhostexProjectId;
  readonly title: string;
  readonly path?: string;
  readonly isFavorite: boolean;
  readonly isPinned: boolean;
  readonly sortKey: string;
}

/** Presentation-snapshot group row (a swimlane of sessions under a project). */
export interface GhostexPresentationGroup {
  readonly groupId: string;
  readonly projectId: GhostexProjectId;
  readonly title: string;
  readonly sessionIds: readonly GhostexSessionId[];
  readonly sortKey: string;
}

/** Presentation-snapshot session row (the activity-bearing UI projection). */
export interface GhostexPresentationSession {
  readonly sessionId: GhostexSessionId;
  readonly projectId: GhostexProjectId;
  readonly groupId: string;
  readonly title: string;
  readonly kind: GhostexSessionKind;
  readonly activity: GhostexSessionActivity;
  readonly lifecycleState: GhostexLifecycleState;
  readonly surface: GhostexSessionSurface;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly cwd?: string;
  readonly isFavorite: boolean;
  readonly isPinned: boolean;
  readonly sortKey: string;
  readonly subtitle?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The presentation snapshot — gxserver's denormalized, UI-ready view of every
 * project/group/session, plus a monotonic `revision` the events stream extends.
 */
export interface GhostexPresentationSnapshot {
  readonly revision: number;
  readonly generatedAt: string;
  readonly projects: readonly GhostexPresentationProject[];
  readonly groups: readonly GhostexPresentationGroup[];
  readonly sessions: readonly GhostexPresentationSession[];
}

/** Minimal `/api/health` body — the unauthenticated liveness + protocol probe. */
export interface GhostexHealth {
  readonly ok: boolean;
  readonly product: string;
  readonly protocolVersion: number;
  readonly version: string;
}

/**
 * `/api/health/server` body — the authenticated, detailed health. Only the
 * fields the Cockpit surfaces are modelled; the rest are accepted and dropped.
 */
export interface GhostexServerHealth extends GhostexHealth {
  readonly serverId: GhostexServerId;
  readonly buildIdentity: string;
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
  readonly capabilities: readonly string[];
}

/** A successful gxserver RPC envelope: `{ ok, product, protocolVersion, requestId, result }`. */
export interface GhostexRpcSuccess<TResult = unknown> {
  readonly ok: true;
  readonly product: string;
  readonly protocolVersion: number;
  readonly requestId: string;
  readonly result: TResult;
}

/** An error gxserver RPC envelope: `{ ok: false, error, message, ... }`. */
export interface GhostexRpcError {
  readonly ok: false;
  readonly product: string;
  readonly protocolVersion?: number;
  readonly requestId?: string;
  readonly error: string;
  readonly message: string;
}

/** Result of the lifecycle endpoints (`sleep`/`wake`/`kill`/`focus`). */
export interface GhostexSessionLifecycleResult {
  readonly session: GhostexSession;
}

/** Result of a typed git/worktree/beads operation (`run*Action`). */
export interface GhostexTypedOperationResult {
  readonly action: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Worktree rows, present only for `worktree list`. */
  readonly worktrees?: readonly GhostexWorktreeEntry[];
}

/** A worktree row from `runWorktreeAction({ action: "list" })`. */
export interface GhostexWorktreeEntry {
  readonly path: string;
  readonly branch: string;
  readonly bare: boolean;
  readonly detached: boolean;
}
