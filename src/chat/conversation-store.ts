// The conversation domain store for one chat session — the heart of the
// chat-with-Mayor feature and its most heavily-tested seam (PRD Testing
// Decisions, Seam 1). It is deliberately free of any `vscode` import: it owns
// the conversation state machine (load a snapshot, apply live stream events,
// drive submit / respond / permission-mode), and emits a plain state object the
// editor-bound panel renders. The panel is thin glue around this store.
import { Emitter } from "../discovery/index.ts";
import {
  getSession,
  getSessionTranscript,
  permissionModeOf,
  sendSessionMessage,
  submitToSession,
  getSessionPending as fetchSessionPending,
  respond as respondToPending,
  setPermissionMode as setSessionPermissionMode,
  streamSession as defaultStreamSession,
  awaitSubmitOutcome as defaultAwaitSubmitOutcome,
  type ApiResult,
  type AsyncAccepted,
  type CockpitClient,
  type ConversationTurn,
  type PendingInteraction,
  type SessionDetail,
  type SessionRespondResult,
  type SessionStreamEvent,
  type StreamEndpoint,
  type SubmissionCapabilities,
  type SubmitIntent,
} from "../api/index.ts";
import type { Disposable } from "../discovery/index.ts";

/** Whether the agent is producing output, waiting, or unknown. */
export type ConversationActivity = "idle" | "in-turn" | "unknown";

/** Lifecycle of the store's connection to the session's live stream. */
export type ConversationConnection =
  | "idle"
  | "loading"
  | "streaming"
  | "closed"
  | "error";

/** The full conversation state the panel renders. Emitted on every change. */
export interface ConversationState {
  readonly cityName: string;
  readonly sessionId: string;
  /** Display title of the session, once loaded. */
  readonly title: string | null;
  /** Producing provider (claude, codex, …), once known. */
  readonly provider: string | null;
  /** The conversation so far; replaced wholesale from transcript/turn snapshots. */
  readonly turns: ConversationTurn[];
  readonly activity: ConversationActivity;
  /** A tool-approval / prompt-for-input awaiting the operator, or null. */
  readonly pending: PendingInteraction | null;
  /** Whether follow-up / interrupt-now submits are supported by the provider. */
  readonly capabilities: SubmissionCapabilities | null;
  /** Current permission mode, when the provider exposes one. */
  readonly permissionMode: string | null;
  readonly connection: ConversationConnection;
  /** True while a submit / respond HTTP call is in flight. */
  readonly sending: boolean;
  /** Last user-facing error, or null. */
  readonly lastError: string | null;
}

export interface ConversationStoreDeps {
  client: CockpitClient;
  endpoint: StreamEndpoint;
  cityName: string;
  sessionId: string;
  /** Injectable per-session stream; defaults to the real SSE stream. */
  streamSession?: typeof defaultStreamSession;
  /**
   * Injectable submit-correlation; defaults to the real city-event correlation.
   * Pass `null` to disable correlation (e.g. unit tests that don't exercise it).
   */
  awaitSubmitOutcome?: typeof defaultAwaitSubmitOutcome | null;
}

/** A mutable partial state update (the public state is deeply `readonly`). */
type StatePatch = Partial<{ -readonly [K in keyof ConversationState]: ConversationState[K] }>;

function normalizeActivity(value: string): ConversationActivity {
  return value === "idle" || value === "in-turn" ? value : "unknown";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns the live conversation for a single session. Construct it, `load()` a
 * snapshot, `connect()` the live stream, and drive it with `submit` / `respond`
 * / `setPermissionMode`. Subscribe via {@link onDidChange}; clean up with
 * {@link dispose}.
 */
export class ConversationStore {
  private readonly emitter = new Emitter<ConversationState>();
  private readonly streamSessionFn: typeof defaultStreamSession;
  private readonly awaitOutcomeFn: typeof defaultAwaitSubmitOutcome | null;

  private streamController: AbortController | null = null;
  private readonly outcomeControllers = new Set<AbortController>();
  private disposed = false;

  private _state: ConversationState;

  constructor(private readonly deps: ConversationStoreDeps) {
    this.streamSessionFn = deps.streamSession ?? defaultStreamSession;
    this.awaitOutcomeFn =
      deps.awaitSubmitOutcome === undefined ? defaultAwaitSubmitOutcome : deps.awaitSubmitOutcome;
    this._state = {
      cityName: deps.cityName,
      sessionId: deps.sessionId,
      title: null,
      provider: null,
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

  private get ref(): { cityName: string; id: string } {
    return { cityName: this.deps.cityName, id: this.deps.sessionId };
  }

  /** Merge a partial state and notify listeners (no-op after dispose). */
  private patch(partial: StatePatch): void {
    if (this.disposed) {
      return;
    }
    this._state = { ...this._state, ...partial };
    this.emitter.fire(this._state);
  }

  /**
   * Fetch the initial snapshot — session detail, transcript, and any pending
   * interaction — in parallel and seed state. Tolerates partial failure: a
   * working transcript still renders even if the detail call fails.
   */
  async load(): Promise<void> {
    this.patch({ connection: "loading", lastError: null });
    const [session, transcript, pending] = await Promise.all([
      getSession(this.deps.client, { ...this.ref, peek: false }),
      getSessionTranscript(this.deps.client, { ...this.ref, format: "conversation" }),
      fetchSessionPending(this.deps.client, this.deps.cityName, this.deps.sessionId),
    ]);

    const next: StatePatch = {};
    if (session.ok) {
      next.title = session.data.title;
      next.provider = session.data.provider;
      next.capabilities = session.data.submission_capabilities ?? null;
      next.permissionMode = permissionModeOf(session.data);
    }
    if (transcript.ok) {
      next.turns = transcript.data.turns ?? [];
      if (next.provider == null) {
        next.provider = transcript.data.provider;
      }
    }
    if (pending.ok) {
      next.pending = pending.data.pending ?? null;
    }

    if (!session.ok && !transcript.ok) {
      next.connection = "error";
      next.lastError = transcript.error.detail ?? transcript.error.title;
    } else {
      next.connection = "idle";
    }
    this.patch(next);
  }

  /**
   * Open the live per-session stream and apply events until the stream closes
   * or {@link dispose}/{@link disconnect} aborts it. Re-callable; any prior
   * stream is torn down first.
   */
  connect(): void {
    this.disconnect();
    const controller = new AbortController();
    this.streamController = controller;
    this.patch({ connection: "streaming" });
    void this.runStream(controller.signal);
  }

  /** Stop the live stream without disposing the store. */
  disconnect(): void {
    this.streamController?.abort();
    this.streamController = null;
  }

  private async runStream(signal: AbortSignal): Promise<void> {
    try {
      for await (const event of this.streamSessionFn(this.deps.endpoint, this.ref, {
        signal,
        format: "conversation",
      })) {
        if (signal.aborted) {
          return;
        }
        this.applyStreamEvent(event);
      }
      if (!signal.aborted) {
        this.patch({ connection: "closed" });
      }
    } catch (err) {
      if (!signal.aborted) {
        this.patch({ connection: "error", lastError: errorMessage(err) });
      }
    }
  }

  /** Apply one decoded stream event to state. Pure aside from {@link patch}. */
  private applyStreamEvent(event: SessionStreamEvent): void {
    switch (event.kind) {
      case "turn":
        // A `turn` event carries the full conversation snapshot; a new turn also
        // means the agent moved past any pending prompt.
        this.patch({ turns: event.turns, pending: null });
        break;
      case "activity": {
        const activity = normalizeActivity(event.activity);
        // Resuming work clears a stale pending prompt.
        this.patch(activity === "in-turn" ? { activity, pending: null } : { activity });
        break;
      }
      case "pending":
        this.patch({ pending: event.pending });
        break;
      case "heartbeat":
      case "raw":
      case "unknown":
      default:
        break;
    }
  }

  /**
   * Submit to the live autonomous loop with an intent (default / follow_up /
   * interrupt_now). Best-effort correlates the request's async outcome and
   * surfaces a failure as {@link ConversationState.lastError}.
   */
  async submit(message: string, intent: SubmitIntent = "default"): Promise<ApiResult<AsyncAccepted>> {
    this.patch({ sending: true, lastError: null });
    const result = await submitToSession(this.deps.client, { ...this.ref, message, intent });
    this.patch({ sending: false });
    if (!result.ok) {
      this.patch({ lastError: result.error.detail ?? result.error.title });
      return result;
    }
    this.trackOutcome(result.data);
    return result;
  }

  /** Send a message without an intent (the throwaway "Ask" side-conversation). */
  async sendMessage(message: string): Promise<ApiResult<AsyncAccepted>> {
    this.patch({ sending: true, lastError: null });
    const result = await sendSessionMessage(this.deps.client, { ...this.ref, message });
    this.patch({ sending: false });
    if (!result.ok) {
      this.patch({ lastError: result.error.detail ?? result.error.title });
      return result;
    }
    this.trackOutcome(result.data);
    return result;
  }

  /** Answer the current pending tool-approval / prompt-for-input. */
  async respond(
    action: string,
    options: { text?: string; metadata?: Record<string, string> } = {},
  ): Promise<ApiResult<SessionRespondResult>> {
    const pending = this._state.pending;
    this.patch({ sending: true, lastError: null });
    const result = await respondToPending(this.deps.client, this.deps.cityName, this.deps.sessionId, {
      action,
      ...(pending ? { requestId: pending.request_id } : {}),
      ...(options.text !== undefined ? { text: options.text } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    });
    this.patch({ sending: false });
    if (!result.ok) {
      this.patch({ lastError: result.error.detail ?? result.error.title });
      return result;
    }
    // Optimistically clear; a subsequent stream event confirms.
    this.patch({ pending: null });
    return result;
  }

  /** Set the session's permission mode and reflect the server's confirmed value. */
  async setPermissionMode(mode: string): Promise<ApiResult<SessionDetail>> {
    this.patch({ lastError: null });
    const result = await setSessionPermissionMode(this.deps.client, this.deps.cityName, this.deps.sessionId, mode);
    if (!result.ok) {
      this.patch({ lastError: result.error.detail ?? result.error.title });
      return result;
    }
    this.patch({ permissionMode: permissionModeOf(result.data) ?? mode });
    return result;
  }

  /** Convenience: load a snapshot then open the live stream. */
  async start(): Promise<void> {
    await this.load();
    if (!this.disposed) {
      this.connect();
    }
  }

  private trackOutcome(accepted: AsyncAccepted): void {
    if (!this.awaitOutcomeFn || this.disposed) {
      return;
    }
    const controller = new AbortController();
    this.outcomeControllers.add(controller);
    void this.awaitOutcomeFn(
      this.deps.endpoint,
      {
        cityName: this.deps.cityName,
        requestId: accepted.request_id,
        ...(accepted.event_cursor ? { eventCursor: accepted.event_cursor } : {}),
      },
      { signal: controller.signal },
    )
      .then((outcome) => {
        if (outcome.kind === "failed") {
          this.patch({ lastError: outcome.errorMessage });
        }
      })
      .catch(() => {
        // Correlation is best-effort; the live stream remains the source of truth.
      })
      .finally(() => {
        this.outcomeControllers.delete(controller);
      });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disconnect();
    for (const controller of this.outcomeControllers) {
      controller.abort();
    }
    this.outcomeControllers.clear();
    this.emitter.dispose();
  }
}
