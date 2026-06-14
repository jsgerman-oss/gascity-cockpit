/**
 * D4b — the *gas-city-hosted, Ghostex-displays* agent-session bridge: the
 * mirror image of D4a's {@link ../chat/ghostex-conversation-store.ts}.
 *
 * In D4a (`ghostex/agent-hosted`) Ghostex **owns** the agent process and the
 * Cockpit reaches *into* gxserver to drive it through a chat panel. Here the
 * gas-city supervisor **owns** the agent session and Ghostex merely **displays**
 * a proxy/attach view of it: a plain Ghostex terminal pane that we keep in sync
 * with the gas-city session's transcript, and `focusSession` to *attach* (bring
 * the pane to front). The operator still drives the agent through gas-city (the
 * owner); Ghostex is an attached window onto it. So the data flows the opposite
 * way from D4a:
 *
 *   - source  → the gas-city session's transcript (injected as a stream of
 *     {@link ProxiedSessionSnapshot}s; in the editor glue a `ConversationStore`,
 *     a fake in tests), the analogue of D4a reading gxserver `readSessionText`.
 *   - pane    → `GhostexProxyClient.createSession` makes a Ghostex terminal pane
 *     (NOT `createAgentSession` — that would spawn a Ghostex-*hosted* agent, the
 *     D4a model); we mirror the transcript into it with `sendSessionText`.
 *   - attach  → `focusSession` reveals the pane (the "attachable" half).
 *
 * A Ghostex pane is append-only through `sendSessionText`, while the gas-city
 * source hands us the *full* transcript on every change, so the proxy diffs the
 * two and appends only the new suffix ({@link paneAppend}). This core never
 * imports `vscode` and needs no live gxserver — both the pane client and the
 * source are injected (PRD Seam 1), so it is unit-tested in plain Node.
 */
import { Emitter, type Disposable } from '../discovery/index.ts';
import type { GhostexSession, GhostexSessionLifecycleResult } from './types.ts';

/**
 * The slice of `GxClient` the proxy drives — the Ghostex *display* side. The
 * real {@link ./gxClient.ts GxClient} satisfies it structurally; tests pass a
 * fake. Deliberately excludes `createAgentSession`: a proxy pane is a plain
 * terminal session we *write into*, never a Ghostex-hosted agent.
 */
export interface GhostexProxyClient {
  createSession(params: { projectId: string; title?: string }): Promise<GhostexSession>;
  sendSessionText(params: { sessionId: string; text: string }): Promise<void>;
  focusSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult>;
  killSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult>;
}

/** Whether the proxied gas-city agent is producing output, waiting, or unknown. */
export type ProxyActivity = 'idle' | 'in-turn' | 'unknown';

/** One conversation turn from the gas-city source (structurally a `ConversationTurn`). */
export interface ProxyTurn {
  readonly role: string;
  readonly text: string;
}

/**
 * A snapshot of the gas-city-owned session to mirror. The source hands the
 * *whole* transcript each time (the gas-city stream replaces turns wholesale),
 * which the proxy diffs against what the pane already shows.
 */
export interface ProxiedSessionSnapshot {
  /** The full conversation so far. */
  readonly turns: readonly ProxyTurn[];
  /** The agent's current activity, reflected onto the proxy state. */
  readonly activity?: ProxyActivity;
  /** Display title, adopted once (the first non-empty title wins). */
  readonly title?: string | null;
  /** True once the source session has ended; the proxy then closes. */
  readonly ended?: boolean;
}

/**
 * Subscribe to the gas-city session's transcript; the callback fires on every
 * change. Returns a disposer. The editor glue wraps a `ConversationStore`; tests
 * push snapshots directly.
 */
export type ProxySourceSubscribe = (onSnapshot: (snapshot: ProxiedSessionSnapshot) => void) => Disposable;

/** Lifecycle of the proxy's link between the gas-city source and the Ghostex pane. */
export type ProxyConnection = 'idle' | 'connecting' | 'mirroring' | 'closed' | 'error';

/** The proxy's observable state, emitted on every change (deeply `readonly`). */
export interface ProxyState {
  /** The gas-city-owned session being proxied. */
  readonly source: { readonly cityName: string; readonly sessionId: string };
  /** The Ghostex pane's session id, once the pane exists. */
  readonly proxySessionId: string | null;
  /** Display title, once known. */
  readonly title: string | null;
  readonly activity: ProxyActivity;
  readonly connection: ProxyConnection;
  /** How many characters of transcript have been mirrored into the pane. */
  readonly mirroredChars: number;
  readonly lastError: string | null;
}

export interface GhostexSessionProxyDeps {
  /** The Ghostex display client (`GxClient.rpc(...)` in the glue, a fake in tests). */
  gx: GhostexProxyClient;
  /** Ghostex project to host the proxy pane in. */
  projectId: string;
  /** The gas-city-owned session being proxied (for labeling + state). */
  source: { cityName: string; sessionId: string };
  /** Live transcript source. */
  subscribe: ProxySourceSubscribe;
  /** Title for the proxy pane. Defaults to a `gas-city: <city>/<id>` label. */
  title?: string;
  /** Kill the Ghostex pane on dispose. Default `false` — leave it for reading. */
  closePaneOnDispose?: boolean;
}

/** The divider written when the transcript diverges and the pane must re-render. */
export const PROXY_RESET_DIVIDER = '— gas-city session view refreshed —';

/** A pane write: the text to append, and whether it re-rendered after a divergence. */
export interface PaneWrite {
  /** Text to append to the (append-only) pane. Empty ⇒ nothing to write. */
  readonly text: string;
  /** True when the transcript diverged and the whole view was re-rendered. */
  readonly reset: boolean;
}

/**
 * Render a gas-city transcript to the flat text a Ghostex terminal pane shows:
 * each non-empty turn as a `[role]` header followed by its text, turns separated
 * by a blank line. Whitespace-only turns (e.g. an assistant turn mid-stream) are
 * omitted, mirroring D4a's `composeGhostexTurns`. Pure.
 */
export function renderTranscript(turns: readonly ProxyTurn[]): string {
  return turns
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn) => `[${turn.role}]\n${turn.text.trimEnd()}`)
    .join('\n\n');
}

/**
 * Compute the append-only write that brings a pane currently showing `previous`
 * up to `next`. A Ghostex pane can only be appended to, while the gas-city source
 * gives the full transcript each time, so:
 *
 *   - identical / nothing to show → write nothing.
 *   - `next` extends `previous` (the common case — the agent appended output or a
 *     new turn) → append just the new suffix.
 *   - `next` *diverges* from `previous` (a turn was edited or the transcript was
 *     replaced) → the pane can't be rewound, so re-render the whole transcript
 *     behind {@link PROXY_RESET_DIVIDER} and flag it a reset.
 *
 * Pure.
 */
export function paneAppend(previous: string, next: string): PaneWrite {
  if (next === previous || next === '') {
    return { text: '', reset: false };
  }
  if (previous === '' || next.startsWith(previous)) {
    return { text: next.slice(previous.length), reset: false };
  }
  return { text: `\n\n${PROXY_RESET_DIVIDER}\n\n${next}`, reset: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A mutable partial state update (the public state is deeply `readonly`). */
type StatePatch = Partial<{ -readonly [K in keyof ProxyState]: ProxyState[K] }>;

/**
 * Proxies one gas-city-owned agent session into a Ghostex pane. Construct it,
 * `start()` (creates the pane + connects the source), `reveal()` to attach, and
 * subscribe via {@link onDidChange}; clean up with {@link dispose}.
 */
export class GhostexSessionProxy {
  private readonly emitter = new Emitter<ProxyState>();
  private subscription: Disposable | null = null;
  private disposed = false;

  /** The transcript text currently reflected in the pane (advanced on a successful send). */
  private lastRendered = '';
  /** The newest snapshot awaiting a push (coalesces bursts to the latest). */
  private pending: ProxiedSessionSnapshot | null = null;
  /** True while a `sendSessionText` is in flight, so pushes stay serialized. */
  private pushing = false;
  /** Latched once a snapshot reports the source ended; closes after the final flush. */
  private sourceEnded = false;
  /** Memoized in-flight pane creation, so concurrent callers share one `createSession`. */
  private paneCreation: Promise<string> | null = null;

  private _state: ProxyState;

  constructor(private readonly deps: GhostexSessionProxyDeps) {
    this._state = {
      source: { cityName: deps.source.cityName, sessionId: deps.source.sessionId },
      proxySessionId: null,
      title: deps.title ?? null,
      activity: 'unknown',
      connection: 'idle',
      mirroredChars: 0,
      lastError: null,
    };
  }

  /** Subscribe to state changes. Returns a disposable that unsubscribes. */
  get onDidChange(): (listener: (state: ProxyState) => void) => Disposable {
    return this.emitter.event;
  }

  /** Current immutable state snapshot. */
  get state(): ProxyState {
    return this._state;
  }

  /** Merge a partial state and notify listeners (no-op after dispose). */
  private patch(partial: StatePatch): void {
    if (this.disposed) {
      return;
    }
    this._state = { ...this._state, ...partial };
    this.emitter.fire(this._state);
  }

  private paneTitle(): string {
    return this.deps.title ?? `gas-city: ${this.deps.source.cityName}/${this.deps.source.sessionId}`;
  }

  /**
   * Create the proxy pane (once) and connect the gas-city source. Eager pane
   * creation means the operator can {@link reveal} an (initially empty) pane the
   * instant the proxy starts, before any transcript arrives.
   */
  async start(): Promise<void> {
    this.patch({ connection: 'connecting', lastError: null });
    try {
      await this.ensurePane();
    } catch (err) {
      this.patch({ connection: 'error', lastError: errorMessage(err) });
      return;
    }
    if (this.disposed) {
      return;
    }
    this.patch({ connection: 'mirroring' });
    this.connectSource();
  }

  /** Lazily create the Ghostex pane, sharing one `createSession` across callers. */
  private ensurePane(): Promise<string> {
    const existing = this._state.proxySessionId;
    if (existing) {
      return Promise.resolve(existing);
    }
    if (!this.paneCreation) {
      this.paneCreation = this.deps.gx
        .createSession({ projectId: this.deps.projectId, title: this.paneTitle() })
        .then((session) => {
          if (!this.disposed) {
            this.patch({ proxySessionId: session.sessionId });
          }
          return session.sessionId;
        })
        .catch((err) => {
          // Let a later call retry from scratch rather than reusing a rejection.
          this.paneCreation = null;
          throw err;
        });
    }
    return this.paneCreation;
  }

  /** Open the source subscription and mirror snapshots until disposed. */
  private connectSource(): void {
    this.disconnect();
    this.subscription = this.deps.subscribe((snapshot) => this.applySnapshot(snapshot));
  }

  /** Stop mirroring the source without disposing the proxy. */
  disconnect(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }

  /** Reflect a source snapshot's activity/title and queue its transcript for the pane. */
  private applySnapshot(snapshot: ProxiedSessionSnapshot): void {
    if (this.disposed) {
      return;
    }
    const next: StatePatch = {};
    if (snapshot.activity) {
      next.activity = snapshot.activity;
    }
    if (snapshot.title && !this._state.title) {
      next.title = snapshot.title;
    }
    if (Object.keys(next).length > 0) {
      this.patch(next);
    }
    if (snapshot.ended) {
      this.sourceEnded = true;
    }
    this.pending = snapshot;
    void this.drainPushes();
  }

  /**
   * Flush queued snapshots into the pane, one `sendSessionText` at a time. Only
   * the latest snapshot matters (transcripts are cumulative), so bursts coalesce.
   * A send failure is soft: `lastRendered` is left un-advanced so the missing
   * text re-sends on the next snapshot, and the error is surfaced, not fatal.
   */
  private async drainPushes(): Promise<void> {
    if (this.pushing || this.disposed) {
      return;
    }
    this.pushing = true;
    try {
      while (this.pending !== null && !this.disposed) {
        const snapshot = this.pending;
        this.pending = null;
        const rendered = renderTranscript(snapshot.turns);
        const write = paneAppend(this.lastRendered, rendered);
        if (write.text.length === 0) {
          this.lastRendered = rendered;
          continue;
        }
        try {
          const paneId = await this.ensurePane();
          await this.deps.gx.sendSessionText({ sessionId: paneId, text: write.text });
        } catch (err) {
          if (!this.disposed) {
            this.patch({ connection: 'error', lastError: errorMessage(err) });
          }
          // Re-queue this snapshot unless a newer one already superseded it.
          if (this.pending === null) {
            this.pending = snapshot;
          }
          break;
        }
        this.lastRendered = rendered;
        if (!this.disposed) {
          this.patch({ mirroredChars: rendered.length, connection: 'mirroring', lastError: null });
        }
      }
    } finally {
      this.pushing = false;
    }
    // The source ended and the final transcript is flushed: close the link.
    if (this.sourceEnded && this.pending === null && !this.disposed) {
      this.disconnect();
      this.patch({ connection: 'closed' });
    }
  }

  /**
   * Attach: bring the proxy pane to the front in Ghostex (`focusSession`),
   * creating it first if needed. Returns whether the reveal succeeded.
   */
  async reveal(): Promise<boolean> {
    try {
      const paneId = await this.ensurePane();
      await this.deps.gx.focusSession({ sessionId: paneId, projectId: this.deps.projectId });
      return true;
    } catch (err) {
      if (!this.disposed) {
        this.patch({ lastError: errorMessage(err) });
      }
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disconnect();
    const paneId = this._state.proxySessionId;
    if (this.deps.closePaneOnDispose && paneId) {
      void this.deps.gx
        .killSession({ sessionId: paneId, projectId: this.deps.projectId })
        .catch(() => {
          // Best-effort teardown; the operator can still close the pane manually.
        });
    }
    this.emitter.dispose();
  }
}
