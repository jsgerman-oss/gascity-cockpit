/**
 * The chat ⇄ Ghostex-agent-session bridge: the `vscode`-free engine that lets the
 * Cockpit chat surface talk to an agent hosted *in a Ghostex pane*, mirroring the
 * Mayor-chat {@link ../chat/conversation-store.ts ConversationStore} pattern but
 * over the gxserver transport.
 *
 * Where the Mayor store streams a supervisor session over SSE, this store drives
 * a Ghostex session:
 *   - **submit** routes to `gxserver sendSessionMessage` (the operator's message
 *     is delivered to the agent's pane);
 *   - **output** streams back by re-reading `readSessionText` — triggered both by
 *     the gxserver `/api/events` presentation deltas for this session (instant)
 *     and by a low-frequency poll (so terminal output that does not bump the
 *     presentation revision still surfaces). Each read is diffed against the last,
 *     so an idle session never repaints.
 *
 * Like the rest of `src/ghostex/`, it is `vscode`-free and unit-tested in plain
 * Node: the gxserver calls are an injected {@link GhostexChatClient} (structurally
 * satisfied by {@link GxClient}), the events feed is an injected {@link subscribe}
 * seam, and the poll timer is injected — so a fake client + manual event dispatch
 * + a fake clock drive the whole lifecycle deterministically. The editor glue that
 * wires the real RPC client, the `/api/events` stream, and the chat webview lives
 * in `src/views/ghostexChat.ts` (PRD "Seam 1", excluded from coverage).
 *
 * {@link toGhostexChatViewState} projects this store's state onto the *existing*
 * chat webview view-model ({@link ChatViewState}) — a type-only import of the pure,
 * `vscode`-free chat protocol — so the same chat UI renders a Ghostex session
 * without a second webview. {@link rankGhostexSessionsForChat} /
 * {@link ghostexChatPickLabel} surface a city's Ghostex *agent* sessions as the
 * selectable chat targets.
 */
import { Emitter } from '../discovery/index.ts';
import type { Disposable } from '../discovery/index.ts';
// Type-only import of the chat webview's view-model. `../chat/protocol.ts` is a
// pure, `vscode`-free projection (its own header), so this neither couples the
// bridge to the editor nor breaks the `src/ghostex` portability posture; it just
// lets a Ghostex session render through the existing chat UI.
import type { ChatTurnView, ChatViewState } from '../chat/protocol.ts';
import type { GhostexEvent } from './events.ts';
import type {
  GhostexSession,
  GhostexSessionActivity,
} from './types.ts';

/** Whether the agent is producing output, waiting on the operator, idle, or unknown. */
export type GhostexChatActivity = 'idle' | 'working' | 'attention' | 'unknown';

/**
 * Lifecycle of the store's link to the session's live output. Deliberately the
 * same vocabulary as the Mayor store's `ConversationConnection`, so the projection
 * onto {@link ChatViewState.connection} is an identity.
 */
export type GhostexChatConnection = 'idle' | 'loading' | 'streaming' | 'closed' | 'error';

/** The full chat state the panel renders. Emitted on every change. */
export interface GhostexChatState {
  readonly sessionId: string;
  /** Display title of the session, once known. */
  readonly title: string | null;
  /** Agent identifier (e.g. "claude"/"codex") backing the session, when known. */
  readonly agentId: string | null;
  /** The session's terminal transcript — replaced wholesale on each fresh read. */
  readonly text: string;
  readonly activity: GhostexChatActivity;
  readonly connection: GhostexChatConnection;
  /** True while a submit RPC is in flight. */
  readonly sending: boolean;
  /** Last user-facing error, or null. */
  readonly lastError: string | null;
}

/**
 * The gxserver surface the bridge drives — structurally satisfied by
 * {@link GxClient}. Modelled as a narrow subset so the store can be unit-tested
 * with a tiny fake (mirrors {@link ../ghostex/agentBridge.ts}'s `AgentLauncher`).
 */
export interface GhostexChatClient {
  readSessionText(params: { sessionId: string }): Promise<string>;
  sendSessionMessage(params: { sessionId: string; text: string }): Promise<void>;
}

/** Registers an events listener and returns an unsubscribe. The store filters to its session. */
export type GhostexEventSubscribe = (listener: (event: GhostexEvent) => void) => () => void;

export interface GhostexChatStoreDeps {
  readonly client: GhostexChatClient;
  readonly sessionId: string;
  /**
   * Subscribe to the gxserver `/api/events` feed. Optional: when absent the store
   * is poll-only (still functional, just without instant deltas), matching the
   * explorer's poll-only fallback on runtimes with no WebSocket.
   */
  readonly subscribe?: GhostexEventSubscribe;
  /** Seed title/agent/activity from the picked session row, before the first read. */
  readonly session?: { title?: string; agentId?: string; activity?: GhostexSessionActivity };
  /** Re-read cadence (ms) while connected. Default 1500. `0` disables polling. */
  readonly pollIntervalMs?: number;
  /** Injected timer (defaults to `setTimeout`), so tests drive the poll with a fake clock. */
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** Outcome of {@link GhostexChatStore.submit} — a typed result, never a throw. */
export type GhostexChatSubmitResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** A mutable partial state update (the public state is deeply `readonly`). */
type StatePatch = Partial<{ -readonly [K in keyof GhostexChatState]: GhostexChatState[K] }>;

const DEFAULT_POLL_MS = 1500;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map a Ghostex session activity onto the store's coarser activity. */
export function toChatActivity(activity: GhostexSessionActivity | undefined): GhostexChatActivity {
  switch (activity) {
    case 'working':
    case 'attention':
    case 'idle':
      return activity;
    default:
      return 'unknown';
  }
}

/**
 * Owns the live chat with a single Ghostex session. Construct it, `load()` the
 * transcript, `connect()` the live output (events + poll), and drive it with
 * `submit`. Subscribe via {@link onDidChange}; clean up with {@link dispose}.
 * `start()` is the convenience load-then-connect the panel uses.
 */
export class GhostexChatStore {
  private readonly emitter = new Emitter<GhostexChatState>();
  private readonly pollIntervalMs: number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private unsubscribe: (() => void) | null = null;
  private pollHandle: unknown = null;
  private connected = false;
  private refreshing = false;
  private disposed = false;

  private _state: GhostexChatState;

  constructor(private readonly deps: GhostexChatStoreDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this._state = {
      sessionId: deps.sessionId,
      title: deps.session?.title ?? null,
      agentId: deps.session?.agentId ?? null,
      text: '',
      activity: toChatActivity(deps.session?.activity),
      connection: 'idle',
      sending: false,
      lastError: null,
    };
  }

  /** Subscribe to state changes. Returns a disposable that unsubscribes. */
  get onDidChange(): (listener: (state: GhostexChatState) => void) => Disposable {
    return this.emitter.event;
  }

  /** Current immutable state snapshot. */
  get state(): GhostexChatState {
    return this._state;
  }

  /** Merge a partial state and notify listeners (no-op after dispose). */
  private patch(partial: StatePatch): void {
    if (this.disposed) return;
    this._state = { ...this._state, ...partial };
    this.emitter.fire(this._state);
  }

  /** Read the initial transcript and seed state. Tolerant: a read failure surfaces as an error. */
  async load(): Promise<void> {
    this.patch({ connection: 'loading', lastError: null });
    try {
      const text = await this.deps.client.readSessionText({ sessionId: this.deps.sessionId });
      if (this.disposed) return;
      this.patch({ text, connection: 'idle' });
    } catch (err) {
      if (!this.disposed) this.patch({ connection: 'error', lastError: errorMessage(err) });
    }
  }

  /**
   * Open the live output: subscribe to the events feed (when provided), read once
   * immediately, and start the poll loop. Re-callable; any prior subscription /
   * timer is torn down first.
   */
  connect(): void {
    if (this.disposed) return;
    this.disconnect();
    this.connected = true;
    if (this.deps.subscribe) {
      this.unsubscribe = this.deps.subscribe((event) => this.onEvent(event));
    }
    this.patch({ connection: 'streaming' });
    void this.refresh();
    this.schedulePoll();
  }

  /** Stop the live output without disposing the store. */
  disconnect(): void {
    this.connected = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearPoll();
  }

  /** Convenience: read the transcript snapshot, then open the live output. */
  async start(): Promise<void> {
    await this.load();
    if (!this.disposed) this.connect();
  }

  /**
   * Deliver the operator's message to the agent via `sendSessionMessage`, then
   * read the session back so the echoed prompt surfaces immediately. Returns a
   * typed result and reflects a failure as {@link GhostexChatState.lastError}.
   */
  async submit(message: string): Promise<GhostexChatSubmitResult> {
    this.patch({ sending: true, lastError: null });
    try {
      await this.deps.client.sendSessionMessage({ sessionId: this.deps.sessionId, text: message });
    } catch (err) {
      const error = errorMessage(err);
      this.patch({ sending: false, lastError: error });
      return { ok: false, error };
    }
    this.patch({ sending: false });
    void this.refresh();
    return { ok: true };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect();
    this.emitter.dispose();
  }

  // --- live output internals ------------------------------------------------

  /** Apply one events frame, narrowed to this session. */
  private onEvent(event: GhostexEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'presentationSnapshot': {
        const session = event.snapshot.sessions.find((s) => s.sessionId === this.deps.sessionId);
        if (session) this.applyPresentation(session.title, session.agentId, session.activity);
        void this.refresh();
        break;
      }
      case 'presentationDelta': {
        const delta = event.delta;
        if (delta.kind === 'sessionUpserted' && delta.session.sessionId === this.deps.sessionId) {
          this.applyPresentation(delta.session.title, delta.session.agentId, delta.session.activity);
          void this.refresh();
        } else if (delta.kind === 'sessionRemoved' && delta.sessionId === this.deps.sessionId) {
          this.patch({ connection: 'closed', activity: 'unknown' });
        }
        break;
      }
      default:
        // eventStreamReady / serverStarted / serverStopping are the shared
        // stream's own lifecycle; the bridge only tracks its session.
        break;
    }
  }

  /** Fold a session's presentation fields into state (only patching real changes). */
  private applyPresentation(
    title: string | undefined,
    agentId: string | undefined,
    activity: GhostexSessionActivity,
  ): void {
    const patch: StatePatch = { activity: toChatActivity(activity) };
    if (title && title !== this._state.title) patch.title = title;
    if (agentId && agentId !== this._state.agentId) patch.agentId = agentId;
    this.patch(patch);
  }

  /** Read the transcript and patch only when it actually changed. Serialized. */
  private async refresh(): Promise<void> {
    if (this.disposed || this.refreshing) return;
    this.refreshing = true;
    try {
      const text = await this.deps.client.readSessionText({ sessionId: this.deps.sessionId });
      if (this.disposed) return;
      if (text !== this._state.text) this.patch({ text });
    } catch (err) {
      if (!this.disposed) this.patch({ lastError: errorMessage(err) });
    } finally {
      this.refreshing = false;
    }
  }

  /** Schedule the next poll tick, if polling is enabled and we are still live. */
  private schedulePoll(): void {
    if (this.pollIntervalMs <= 0 || !this.connected || this.disposed) return;
    this.pollHandle = this.setTimer(() => {
      this.pollHandle = null;
      void this.refresh().finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
  }

  private clearPoll(): void {
    if (this.pollHandle !== null) {
      this.clearTimer(this.pollHandle);
      this.pollHandle = null;
    }
  }
}

// --- Projection onto the chat webview view-model ----------------------------

/**
 * Project the bridge state onto the chat webview's {@link ChatViewState}, so a
 * Ghostex session renders through the *existing* chat UI. A terminal session has
 * no structured turns, pending approvals, submit intents, or permission mode, so
 * the transcript becomes a single `agent` turn and those facets are flattened to
 * their inert values (the webview then shows just a transcript + a plain composer).
 */
export function toGhostexChatViewState(state: GhostexChatState): ChatViewState {
  const turns: ChatTurnView[] = state.text ? [{ role: 'agent', text: state.text }] : [];
  return {
    cityName: '',
    sessionId: state.sessionId,
    title: state.title ?? state.sessionId,
    provider: state.agentId,
    connection: state.connection,
    activity: state.activity === 'working' ? 'in-turn' : state.activity === 'idle' ? 'idle' : 'unknown',
    turns,
    pending: null,
    capabilities: { followUp: false, interruptNow: false },
    permissionMode: null,
    sending: state.sending,
    error: state.lastError,
    notice: null,
  };
}

// --- Chat-target selection (Ghostex agent sessions) -------------------------

/** A QuickPick-ready Ghostex chat target (label/description/detail + the session id). */
export interface GhostexChatPickLabel {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

/** Lower sorts first: a running agent is the readiest chat target. */
function lifecycleRank(session: GhostexSession): number {
  switch (session.lifecycleState) {
    case 'running':
      return 0;
    case 'sleeping':
      return 1;
    case 'unknown':
      return 2;
    default:
      return 3;
  }
}

/**
 * The chat targets a city offers: its Ghostex **agent** sessions (a raw terminal
 * is not a chat peer), ordered running-first then by title. Returns a new array;
 * does not mutate input.
 */
export function rankGhostexSessionsForChat(sessions: readonly GhostexSession[]): GhostexSession[] {
  return sessions
    .filter((session) => session.kind === 'agent')
    .sort((a, b) => {
      const byLifecycle = lifecycleRank(a) - lifecycleRank(b);
      if (byLifecycle !== 0) return byLifecycle;
      return chatLabel(a).localeCompare(chatLabel(b));
    });
}

/** Build the picker label for one Ghostex agent session. Pure. */
export function ghostexChatPickLabel(session: GhostexSession): GhostexChatPickLabel {
  const agent = session.agentId ? `agent:${session.agentId}` : 'agent';
  return {
    id: session.sessionId,
    label: chatLabel(session),
    description: `${agent} · ${session.lifecycleState}`,
    detail: session.globalRef,
  };
}

function chatLabel(session: GhostexSession): string {
  return session.title || session.sessionId;
}
