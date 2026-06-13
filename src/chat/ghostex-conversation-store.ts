// The conversation store for a *Ghostex-hosted agent session* — the Ghostex-side
// mirror of the cockpit `ConversationStore`. It speaks the gxserver contract
// instead of the gascity `/v0` API, but emits the *same* {@link ConversationState},
// so the protocol projection (`toViewState`) and the webview render it unchanged.
//
//   - submit  → `GxClient.sendSessionMessage({ sessionId, text })`  (fire-and-confirm)
//   - output  → `GxClient.readSessionText({ sessionId })`           (full text buffer)
//   - "stream" → re-read the buffer whenever a gxserver presentation event touches
//     this session (its activity / lifecycle changed), mirroring the SSE reader's
//     "apply each event" loop in `src/api/sse.ts`. The event source is *injected*
//     (a `GhostexEventStream` in the editor glue, a fake in tests), so this core
//     needs no real socket and is unit-testable in plain Node (PRD Seam 1).
//
// gxserver returns an agent session's output as one flat text buffer with no role
// structure, so the bridge shows each operator prompt as a `user` turn followed by
// the agent's current full output as a single `assistant` turn (see
// {@link composeGhostexTurns}). Ghostex agent sessions expose no tool-approval /
// permission-mode surface through this bridge, so `respond` / `setPermissionMode`
// are inert and the composer never shows those controls (`pending`/`permissionMode`
// stay null, `capabilities` stays null → only the default submit intent is offered).
import { Emitter, type Disposable } from "../discovery/index.ts";
import type { ConversationActivity, ConversationState } from "./conversation-store.ts";
import type { ChatActionResult, ChatConversation } from "./chat-conversation.ts";
import type { ConversationTurn, SubmitIntent } from "../api/index.ts";
import type {
  GhostexEvent,
  GhostexPresentationSession,
  GhostexSessionActivity,
} from "../ghostex/index.ts";

/** The slice of `GxClient` this store drives. The real client satisfies it; tests pass a fake. */
export interface GhostexChatClient {
  readSessionText(params: { sessionId: string }): Promise<string>;
  sendSessionMessage(params: { sessionId: string; text: string }): Promise<void>;
}

/**
 * Subscribe to gxserver presentation events; the store re-reads this session's
 * text whenever an event touches it. Returns a disposer. The editor glue wraps a
 * `GhostexEventStream` (WebSocket) or a snapshot poll; tests push events directly.
 */
export type GhostexEventSubscribe = (onEvent: (event: GhostexEvent) => void) => Disposable;

export interface GhostexConversationStoreDeps {
  /** The gxserver client (`GxClient.rpc(...)` in the glue, a fake in tests). */
  gx: GhostexChatClient;
  /** The Ghostex agent session id to converse with. */
  sessionId: string;
  /** Display title; refined from the live snapshot when this session is seen. */
  title?: string;
  /** Producing agent id/name, shown as the provider chip. Default `"ghostex"`. */
  provider?: string;
  /** Label rendered where the cockpit store shows the city name. Default `"ghostex"`. */
  label?: string;
  /** Live event source. Omit for a one-shot snapshot with no live updates. */
  subscribe?: GhostexEventSubscribe;
}

/**
 * Map a Ghostex session activity onto the cockpit conversation's activity
 * vocabulary. `working` is an in-flight turn; `idle` and `attention` both read as
 * "not producing — your turn", so the composer stays enabled. Pure.
 */
export function ghostexActivityToConversation(activity: GhostexSessionActivity): ConversationActivity {
  return activity === "working" ? "in-turn" : "idle";
}

/**
 * Project the operator's prompts + the agent's current text buffer into turns.
 * gxserver returns the session output as one flat buffer (no roles), so the
 * bridge shows each prompt as a `user` turn followed by the agent's full current
 * output as a single trailing `assistant` turn (omitted while the buffer is
 * empty/whitespace). Pure.
 */
export function composeGhostexTurns(
  userMessages: readonly string[],
  agentText: string,
): ConversationTurn[] {
  const turns: ConversationTurn[] = userMessages.map((text) => ({ role: "user", text }));
  if (agentText.trim().length > 0) {
    turns.push({ role: "assistant", text: agentText });
  }
  return turns;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A mutable partial state update (the public state is deeply `readonly`). */
type StatePatch = Partial<{ -readonly [K in keyof ConversationState]: ConversationState[K] }>;

/**
 * Owns the live conversation for a single Ghostex agent session. Construct it,
 * `load()` the current buffer, `connect()` the event source, and drive it with
 * `submit`. Subscribe via {@link onDidChange}; clean up with {@link dispose}.
 */
export class GhostexConversationStore implements ChatConversation {
  private readonly emitter = new Emitter<ConversationState>();
  private subscription: Disposable | null = null;
  private disposed = false;

  /** Operator prompts, shown as optimistic `user` turns ahead of the agent buffer. */
  private readonly userMessages: string[] = [];
  /** The agent session's latest text buffer, from `readSessionText`. */
  private agentText = "";
  /** Serialize reads: one in flight at a time, with at most one queued behind it. */
  private refreshing = false;
  private refreshQueued = false;

  private _state: ConversationState;

  constructor(private readonly deps: GhostexConversationStoreDeps) {
    this._state = {
      cityName: deps.label ?? "ghostex",
      sessionId: deps.sessionId,
      title: deps.title ?? null,
      provider: deps.provider ?? "ghostex",
      turns: [],
      activity: "unknown",
      pending: null,
      capabilities: null,
      permissionMode: null,
      connection: "idle",
      sending: false,
      lastError: null,
    };
  }

  /** Subscribe to state changes. Returns a disposable that unsubscribes. */
  get onDidChange(): (listener: (state: ConversationState) => void) => Disposable {
    return this.emitter.event;
  }

  /** Current immutable state snapshot. */
  get state(): ConversationState {
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

  /** Read the current session text and seed state. Tolerates a read failure. */
  async load(): Promise<void> {
    this.patch({ connection: "loading", lastError: null });
    try {
      const text = await this.deps.gx.readSessionText({ sessionId: this.deps.sessionId });
      if (this.disposed) {
        return;
      }
      this.agentText = text;
      this.patch({ turns: this.composeTurns(), connection: "idle" });
    } catch (err) {
      if (this.disposed) {
        return;
      }
      this.patch({ connection: "error", lastError: errorMessage(err) });
    }
  }

  /** Open the live event source and apply this session's events until disposed. */
  connect(): void {
    this.disconnect();
    if (!this.deps.subscribe) {
      // No live source: stay on the loaded snapshot (preserve a prior load error).
      if (this._state.connection !== "error") {
        this.patch({ connection: "idle" });
      }
      return;
    }
    this.patch({ connection: "streaming" });
    this.subscription = this.deps.subscribe((event) => this.applyEvent(event));
  }

  /** Stop the live event source without disposing the store. */
  disconnect(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }

  /** Apply one gxserver presentation event. Pure aside from {@link patch}/{@link refresh}. */
  private applyEvent(event: GhostexEvent): void {
    if (this.disposed) {
      return;
    }
    switch (event.type) {
      case "presentationSnapshot": {
        const session = event.snapshot.sessions.find((s) => s.sessionId === this.deps.sessionId);
        if (session) {
          this.applySession(session);
        }
        break;
      }
      case "presentationDelta": {
        const { delta } = event;
        if (delta.kind === "sessionUpserted" && delta.session.sessionId === this.deps.sessionId) {
          this.applySession(delta.session);
        } else if (delta.kind === "sessionRemoved" && delta.sessionId === this.deps.sessionId) {
          this.patch({ connection: "closed" });
        }
        break;
      }
      case "serverStopping":
        // The daemon is going away; the live conversation can't continue.
        this.patch({ connection: "closed" });
        break;
      default:
        // eventStreamReady / serverStarted and any unrelated delta: ignore.
        break;
    }
  }

  /** Reflect a session's latest activity/title and re-read its text. */
  private applySession(session: GhostexPresentationSession): void {
    const next: StatePatch = { activity: ghostexActivityToConversation(session.activity) };
    if (!this._state.title && session.title) {
      next.title = session.title;
    }
    this.patch(next);
    void this.refresh();
  }

  /** Re-read the session text and update turns. Serialized to one read at a time. */
  private async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      const text = await this.deps.gx.readSessionText({ sessionId: this.deps.sessionId });
      if (this.disposed) {
        return;
      }
      if (text !== this.agentText) {
        this.agentText = text;
        this.patch({ turns: this.composeTurns() });
      }
    } catch (err) {
      // A transient read failure shouldn't tear down the stream; surface it softly.
      if (!this.disposed) {
        this.patch({ lastError: errorMessage(err) });
      }
    } finally {
      this.refreshing = false;
      if (this.refreshQueued && !this.disposed) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private composeTurns(): ConversationTurn[] {
    return composeGhostexTurns(this.userMessages, this.agentText);
  }

  /**
   * Send the operator's message to the Ghostex agent session. gxserver has no
   * submit-intent concept, so `intent` is accepted (to satisfy the chat contract)
   * but not forwarded. Optimistically shows the prompt as a `user` turn.
   */
  async submit(message: string, _intent: SubmitIntent = "default"): Promise<ChatActionResult> {
    this.userMessages.push(message);
    this.patch({ sending: true, lastError: null, turns: this.composeTurns() });
    try {
      await this.deps.gx.sendSessionMessage({ sessionId: this.deps.sessionId, text: message });
      if (!this.disposed) {
        this.patch({ sending: false });
      }
      void this.refresh();
      return { ok: true };
    } catch (err) {
      if (!this.disposed) {
        this.patch({ sending: false, lastError: errorMessage(err) });
      }
      return { ok: false };
    }
  }

  /** Ghostex agent sessions expose no tool-approval surface through this bridge. */
  async respond(): Promise<ChatActionResult> {
    return { ok: false };
  }

  /** Ghostex agent sessions expose no permission-mode surface through this bridge. */
  async setPermissionMode(): Promise<ChatActionResult> {
    return { ok: false };
  }

  /** Convenience: load the buffer then open the live event source. */
  async start(): Promise<void> {
    await this.load();
    if (!this.disposed) {
      this.connect();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disconnect();
    this.emitter.dispose();
  }
}
