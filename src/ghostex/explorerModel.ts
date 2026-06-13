/**
 * The `vscode`-free core behind the Ghostex Sessions explorer (the
 * projects→sessions tree the operator drives Ghostex from). Like the rest of
 * `src/ghostex/`, it is unit-tested in plain Node — no `vscode`, no live
 * gxserver — so the editor-bound glue in `src/views/ghostexExplorer.ts` stays
 * thin (and excluded from coverage, per the PRD "Seam 1" testing decisions).
 *
 * What lives here:
 *   - a small in-memory model of the presentation snapshot (projects, groups,
 *     sessions, keyed by id) that {@link GhostexExplorerModel.seed seeds} from a
 *     {@link GhostexPresentationSnapshot} and advances by applying the live
 *     {@link GhostexEvent} deltas the events stream emits;
 *   - the projects→sessions tree shape the explorer renders, built from that
 *     model (sessions ordered by their group's then their own `sortKey`);
 *   - the pure presentation of a session — the codicon that folds *lifecycle*
 *     (running/sleeping/stopped/…) and *activity* (attention/working/idle) into
 *     one at-a-glance glyph, the description, the tooltip, the screen-reader
 *     label, and the `contextValue` the context menus key their drive-actions
 *     off;
 *   - a tiny state resolver that picks the loading/empty/unavailable/reconnecting
 *     row, reusing the shared tone vocabulary (`STATE_LOOK`) so the Ghostex pane
 *     reads like every other Cockpit pane while wording itself for gxserver.
 *
 * The split mirrors the Beads explorer (`buildBeadTree` in the tested `../beads`
 * core, thin glue in `../views/beadsExplorer.ts`).
 */
import { STATE_LOOK, type StateNotice, type StateTone } from '../ui/index.ts';
import type { GhostexDelta, GhostexEvent } from './events.ts';
import type {
  GhostexLifecycleState,
  GhostexPresentationGroup,
  GhostexPresentationProject,
  GhostexPresentationSession,
  GhostexPresentationSnapshot,
  GhostexSessionActivity,
} from './types.ts';

// --- Connection state -------------------------------------------------------

/**
 * How the explorer sees its gxserver link. Folded from discovery + the events
 * stream's own lifecycle by the glue:
 *
 * - `discovering` — the first probe/snapshot is still in flight.
 * - `connected` — gxserver is reachable and a snapshot has been (or is being)
 *   loaded; the pane's own data decides what shows.
 * - `unavailable` — gxserver could not be reached (discovery failed, or the
 *   stream gave up after backing off); a hard "it's not there" row.
 * - `reconnecting` — the stream was open and dropped; the Cockpit is backing off
 *   and will recover, so stale rows stay under a "reconnecting" banner.
 */
export type GhostexConnState = 'discovering' | 'connected' | 'unavailable' | 'reconnecting';

// --- Tree nodes -------------------------------------------------------------

/** A project row (tree root). Rollups summarise its sessions for the row's badge. */
export interface GhostexProjectNode {
  readonly kind: 'project';
  /** Stable tree id (`project:<projectId>`). */
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly path?: string;
  /** Total sessions under this project. */
  readonly sessionCount: number;
  /** Sessions whose activity is `attention` (the operator-action-needed count). */
  readonly attentionCount: number;
  /** Sessions whose lifecycle is `running`. */
  readonly runningCount: number;
  readonly isFavorite: boolean;
  readonly isPinned: boolean;
}

/** A session row (leaf under a project), with its fully-resolved presentation. */
export interface GhostexSessionNode {
  readonly kind: 'session';
  /** Stable tree id (`session:<sessionId>`). */
  readonly id: string;
  readonly session: GhostexPresentationSession;
  readonly presentation: SessionPresentation;
}

/** A notice row standing in for content (loading / empty / unavailable / reconnecting). */
export interface GhostexMessageNode {
  readonly kind: 'message';
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly icon: string;
  readonly iconColor?: string;
}

export type GhostexTreeNode = GhostexProjectNode | GhostexSessionNode | GhostexMessageNode;

/** The pure, editor-agnostic presentation of a session row. */
export interface SessionPresentation {
  /** Codicon id (no `$(...)`), folding lifecycle + activity into one glyph. */
  readonly icon: string;
  /** Optional `ThemeColor` id the glue tints the icon with. */
  readonly iconColor?: string;
  /** The row label (the session title, falling back to its id). */
  readonly label: string;
  /** The row description — `<kind[:agent]> · <lifecycle>`. */
  readonly description: string;
  /** Markdown tooltip body. */
  readonly tooltip: string;
  /**
   * The `contextValue` the menus match — `ghostexSession.<kind>.<lifecycle>` —
   * so a `when` clause can scope an action to e.g. only running sessions
   * (`viewItem =~ /\.running$/`) or only agents (`/^ghostexSession\.agent\./`).
   */
  readonly contextValue: string;
  /** Screen-reader label folding the icon-conveyed state into words (a11y). */
  readonly accessibleLabel: string;
}

// --- Pure presentation helpers ----------------------------------------------

/** Activity → its glyph, used while a session's lifecycle is live (running/unknown). */
const ACTIVITY_LOOK: Record<GhostexSessionActivity, { icon: string; color?: string }> = {
  attention: { icon: 'bell-dot', color: 'list.warningForeground' },
  working: { icon: 'sync~spin', color: 'charts.blue' },
  idle: { icon: 'circle-outline' },
};

/** Lifecycle → human label (kept stable for the description + a11y string). */
const LIFECYCLE_LABEL: Record<GhostexLifecycleState, string> = {
  running: 'running',
  sleeping: 'sleeping',
  stopped: 'stopped',
  missing: 'missing',
  unknown: 'unknown',
};

/**
 * The single glyph an operator scans for. Lifecycle dominates: a sleeping /
 * stopped / missing session reads as dimmed and paused/slashed regardless of its
 * last-known activity; a *live* session (running, or an unknown lifecycle we
 * optimistically treat as live) shows its activity — the spinner while working,
 * the bell when it wants attention, a hollow dot when idle.
 */
export function sessionIcon(session: GhostexPresentationSession): { icon: string; color?: string } {
  switch (session.lifecycleState) {
    case 'sleeping':
      return { icon: 'debug-pause', color: 'disabledForeground' };
    case 'stopped':
      return { icon: 'circle-slash', color: 'disabledForeground' };
    case 'missing':
      return { icon: 'question', color: 'disabledForeground' };
    case 'running':
    case 'unknown':
    default:
      return ACTIVITY_LOOK[session.activity] ?? { icon: 'circle-outline' };
  }
}

/** `agent:<name>` / `agent:<id>` / `agent` / `terminal` — the kind label for a session. */
export function sessionKindLabel(session: GhostexPresentationSession): string {
  if (session.kind !== 'agent') return 'terminal';
  const agent = session.agentName ?? session.agentId;
  return agent ? `agent:${agent}` : 'agent';
}

/** Resolve every editor-agnostic facet of a session row in one place. */
export function computeSessionPresentation(session: GhostexPresentationSession): SessionPresentation {
  const glyph = sessionIcon(session);
  const kindLabel = sessionKindLabel(session);
  const lifecycle = LIFECYCLE_LABEL[session.lifecycleState] ?? session.lifecycleState;
  const presentation: SessionPresentation = {
    icon: glyph.icon,
    label: session.title || session.sessionId,
    description: `${kindLabel} · ${lifecycle}`,
    tooltip: sessionTooltip(session, kindLabel, lifecycle),
    contextValue: `ghostexSession.${session.kind}.${session.lifecycleState}`,
    accessibleLabel: `${session.title || session.sessionId}, ${kindLabel}, ${session.activity}, ${lifecycle}`,
  };
  return glyph.color ? { ...presentation, iconColor: glyph.color } : presentation;
}

function sessionTooltip(
  session: GhostexPresentationSession,
  kindLabel: string,
  lifecycle: string,
): string {
  const lines = [
    `**${session.title || session.sessionId}**`,
    '',
    `${kindLabel} · ${lifecycle} · ${session.activity}`,
  ];
  if (session.subtitle) lines.push('', session.subtitle);
  if (session.cwd) lines.push('', `\`${session.cwd}\``);
  lines.push('', `surface: ${session.surface} · updated ${session.updatedAt}`, `id: \`${session.sessionId}\``);
  return lines.join('\n');
}

// --- Notice resolution (Ghostex-worded, shared tone vocabulary) -------------

/** Build a {@link StateNotice} from the shared tone look, worded for Ghostex. */
function ghostexNotice(tone: StateTone, label: string, detail?: string, iconOverride?: string): StateNotice {
  const look = STATE_LOOK[tone];
  const notice: StateNotice = { tone, label, icon: iconOverride ?? look.icon };
  if (detail) notice.detail = detail;
  if (look.iconColor) notice.iconColor = look.iconColor;
  return notice;
}

/**
 * Pick the single "no real content" row for the explorer, or `null` to render
 * the tree as-is. Mirrors the ordering of the shared {@link resolvePaneState}
 * (lost link first, then coming-up, then the live pane's own data) but words
 * itself for gxserver and treats a hard `unavailable` as its own row.
 */
export function resolveGhostexNotice(
  conn: GhostexConnState,
  ctx: { loaded: boolean; hasContent: boolean; detail?: string | null },
): StateNotice | null {
  if (conn === 'reconnecting') {
    return ghostexNotice('reconnecting', 'Reconnecting to Ghostex…', ctx.detail ?? undefined);
  }
  if (conn === 'unavailable') {
    return ghostexNotice('error', 'Ghostex unavailable', ctx.detail ?? undefined, 'plug');
  }
  if (conn === 'discovering') {
    return ctx.hasContent ? null : ghostexNotice('loading', 'Connecting to Ghostex…');
  }
  // connected — the pane's own data decides.
  if (ctx.hasContent) return null;
  if (!ctx.loaded) return ghostexNotice('loading', 'Loading Ghostex sessions…');
  return ghostexNotice('empty', 'No Ghostex sessions', 'No projects or sessions are open in Ghostex.', 'ghost');
}

// --- The model --------------------------------------------------------------

/**
 * The explorer's in-memory state: the latest presentation snapshot, kept current
 * by applying the events stream's deltas. The glue seeds it from
 * `gxClient.readPresentationSnapshot()` (and from any `presentationSnapshot`
 * event), feeds it every {@link GhostexEvent}, and reads {@link roots} /
 * {@link childrenOf} to render — re-rendering only when a mutator reports a
 * change, so an idle stream of no-op deltas does not repaint the tree.
 */
export class GhostexExplorerModel {
  private readonly projects = new Map<string, GhostexPresentationProject>();
  private readonly groups = new Map<string, GhostexPresentationGroup>();
  private readonly sessions = new Map<string, GhostexPresentationSession>();
  private revision: number | null = null;
  private loaded = false;
  private conn: GhostexConnState = 'discovering';
  private detail: string | null = null;

  /** Highest snapshot/delta revision applied (for diagnostics), or `null`. */
  get currentRevision(): number | null {
    return this.revision;
  }

  /** The current connection state. */
  get connState(): GhostexConnState {
    return this.conn;
  }

  /** Whether at least one snapshot has been seeded. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Replace the whole model from a fresh snapshot (initial load, or a
   * `presentationSnapshot` event). A successful snapshot means we are connected,
   * so this clears any prior unavailable/reconnecting state. Always reports a
   * change — a reseed always repaints.
   */
  seed(snapshot: GhostexPresentationSnapshot): boolean {
    this.projects.clear();
    this.groups.clear();
    this.sessions.clear();
    for (const project of snapshot.projects) this.projects.set(project.projectId, project);
    for (const group of snapshot.groups) this.groups.set(group.groupId, group);
    for (const session of snapshot.sessions) this.sessions.set(session.sessionId, session);
    this.revision = snapshot.revision;
    this.loaded = true;
    this.conn = 'connected';
    this.detail = null;
    return true;
  }

  /**
   * Apply one typed event. Returns whether the *rendered tree* changed (so the
   * glue can skip a repaint on a no-op). The revision advances on every
   * snapshot/delta frame regardless, mirroring what the stream itself tracks.
   */
  applyEvent(event: GhostexEvent): boolean {
    switch (event.type) {
      case 'presentationSnapshot':
        return this.seed(event.snapshot);
      case 'presentationDelta':
        return this.applyDelta(event.revision, event.delta);
      case 'serverStopping':
        // The daemon is going down; surface the reconnecting banner over any
        // stale rows until the stream re-establishes (or gives up).
        return this.setConnState('reconnecting');
      case 'eventStreamReady':
      case 'serverStarted':
        // The link is (re)established; if we were degraded, recover to connected.
        return this.conn === 'connected' ? false : this.setConnState('connected');
      default:
        return false;
    }
  }

  private applyDelta(revision: number, delta: GhostexDelta): boolean {
    let changed = false;
    switch (delta.kind) {
      case 'sessionUpserted':
        this.sessions.set(delta.session.sessionId, delta.session);
        changed = true;
        break;
      case 'sessionRemoved':
        changed = this.sessions.delete(delta.sessionId);
        break;
      case 'projectRemoved':
        changed = this.removeProject(delta.projectId);
        break;
      case 'other':
        changed = false;
        break;
    }
    if (this.revision === null || revision > this.revision) this.revision = revision;
    return changed;
  }

  /** Drop a project and everything under it. Returns whether anything was removed. */
  private removeProject(projectId: string): boolean {
    let removed = this.projects.delete(projectId);
    for (const [id, group] of this.groups) {
      if (group.projectId === projectId) {
        this.groups.delete(id);
        removed = true;
      }
    }
    for (const [id, session] of this.sessions) {
      if (session.projectId === projectId) {
        this.sessions.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  /**
   * Move the connection state (and optional detail). Idempotent: a no-op
   * transition returns `false` so the glue does not repaint. Reaching
   * `connected` here (without a snapshot) does not flip `loaded` — only a seed
   * does that.
   */
  setConnState(conn: GhostexConnState, detail?: string | null): boolean {
    const nextDetail = detail ?? null;
    if (this.conn === conn && this.detail === nextDetail) return false;
    this.conn = conn;
    this.detail = nextDetail;
    return true;
  }

  /**
   * The tree roots: either the project rows, or a single notice row standing in
   * for them — with the one exception that a `reconnecting` banner rides *over*
   * retained project rows (stale-but-useful beats a blank pane).
   */
  roots(): GhostexTreeNode[] {
    const projectNodes = this.projectNodes();
    const notice = resolveGhostexNotice(this.conn, {
      loaded: this.loaded,
      hasContent: projectNodes.length > 0,
      detail: this.detail,
    });
    if (!notice) return projectNodes;
    const row = messageNode(notice);
    return notice.tone === 'reconnecting' && projectNodes.length > 0 ? [row, ...projectNodes] : [row];
  }

  /** The session rows under a project (empty for any other node). */
  childrenOf(node: GhostexTreeNode): GhostexTreeNode[] {
    if (node.kind !== 'project') return [];
    return this.sessionsForProject(node.projectId).map((session) => this.sessionNode(session));
  }

  private projectNodes(): GhostexProjectNode[] {
    return [...this.projects.values()]
      .sort((a, b) => compareSortKey(a.sortKey, a.title, b.sortKey, b.title))
      .map((project) => {
        const sessions = this.sessionsForProject(project.projectId);
        const node: GhostexProjectNode = {
          kind: 'project',
          id: `project:${project.projectId}`,
          projectId: project.projectId,
          title: project.title,
          sessionCount: sessions.length,
          attentionCount: sessions.filter((s) => s.activity === 'attention').length,
          runningCount: sessions.filter((s) => s.lifecycleState === 'running').length,
          isFavorite: project.isFavorite,
          isPinned: project.isPinned,
        };
        return project.path ? { ...node, path: project.path } : node;
      });
  }

  /** Sessions for a project, ordered by their group's then their own `sortKey`. */
  private sessionsForProject(projectId: string): GhostexPresentationSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.projectId === projectId)
      .sort((a, b) =>
        compareSortKey(this.groupSortKey(a), a.sortKey, this.groupSortKey(b), b.sortKey) ||
        a.title.localeCompare(b.title),
      );
  }

  /** A session's group `sortKey`, or a high sentinel so ungrouped sessions sink last. */
  private groupSortKey(session: GhostexPresentationSession): string {
    return this.groups.get(session.groupId)?.sortKey ?? '￿';
  }

  private sessionNode(session: GhostexPresentationSession): GhostexSessionNode {
    return {
      kind: 'session',
      id: `session:${session.sessionId}`,
      session,
      presentation: computeSessionPresentation(session),
    };
  }
}

/** Order by primary then secondary `sortKey`, ties broken by title. */
function compareSortKey(aKey: string, aTitle: string, bKey: string, bTitle: string): number {
  return aKey.localeCompare(bKey) || aTitle.localeCompare(bTitle);
}

function messageNode(notice: StateNotice): GhostexMessageNode {
  const node: GhostexMessageNode = {
    kind: 'message',
    id: `message:${notice.tone}`,
    label: notice.label,
    icon: notice.icon,
  };
  return {
    ...node,
    ...(notice.detail ? { detail: notice.detail } : {}),
    ...(notice.iconColor ? { iconColor: notice.iconColor } : {}),
  };
}
