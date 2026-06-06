// The ACP ⇄ /v0 mapping: a `MayorAgent` that answers ACP client requests by
// driving a Mayor chat session over the typed `/v0` client from `src/core`.
//
// This is the heart of the adapter and the seam the message-mapping tests
// exercise. It is `vscode`-free and consumes only the **core boundary**
// (`core.api`) — the same sessions / approvals / SSE surface the VS Code chat
// uses — so the editor and Zed drive the Mayor through one shared client.
//
// What it maps:
//   ACP session/prompt            → POST /v0 …/submit  (or …/respond when the
//                                    session is awaiting a prompt-for-input)
//   /v0 per-session `turn` stream  → session/update {agent_message_chunk}
//   /v0 `pending` tool-approval    → session/request_permission → …/respond
//   /v0 `pending` prompt-for-input → an agent_message + end_turn; the next
//                                    prompt is routed back as the answer
//   ACP session/cancel            → abort the in-flight turn (stopReason cancelled)
//
// The turn projection (assistant-text delta + activity→idle completion) mirrors
// the proven VS Code chat participant bridge (src/chat/participant-bridge.ts);
// it is re-derived here against `core.api` rather than imported because the chat
// slice is per-surface glue, not part of the portable `core` boundary.
import * as core from "../../src/core/index.ts";
import {
  ACP_PROTOCOL_VERSION,
  METHOD_AUTHENTICATE,
  METHOD_INITIALIZE,
  METHOD_SESSION_CANCEL,
  METHOD_SESSION_LOAD,
  METHOD_SESSION_NEW,
  METHOD_SESSION_PROMPT,
  RpcError,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  agentMessageChunk,
  contentBlocksToText,
  type CancelParams,
  type InitializeResult,
  type NewSessionResult,
  type PermissionOption,
  type PromptParams,
  type PromptResult,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionNotification,
  type StopReason,
} from "./protocol.ts";

// Core domain types, aliased for readable signatures below.
type ApiResult<T> = core.api.ApiResult<T>;
type ConversationTurn = core.api.ConversationTurn;
type PendingInteraction = core.api.PendingInteraction;
type StreamEndpoint = core.api.StreamEndpoint;
type CockpitClient = core.api.CockpitClient;

/** What the agent needs from the JSON-RPC peer to talk back to the client. */
export interface AcpClient {
  /** Emit a `session/update` notification (assistant text chunk, etc.). */
  sendUpdate(note: SessionNotification): void;
  /** Ask the client to resolve a tool-approval; resolves with their choice. */
  requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult>;
}

/** Which Mayor session this adapter targets. */
export interface MayorConfig {
  /** Explicit target city; when omitted, auto-resolved if the supervisor has exactly one. */
  cityName?: string;
  /** The /v0 session id, alias, or runtime name to chat with (default `"mayor"`). */
  mayorSession: string;
  /** Optional initial permission mode set on `session/new` (e.g. `acceptEdits`, `plan`). */
  permissionMode?: string;
}

/**
 * Injectable slice of `core.api`. Defaults bind to the real client/endpoint;
 * tests pass fakes to exercise the mapping without a network — the same
 * dependency-injection seam `ConversationStore` uses.
 */
export interface MayorAgentDeps {
  client: CockpitClient;
  endpoint: StreamEndpoint;
  config: MayorConfig;
  acp: AcpClient;
  listCities?: typeof core.api.listCities;
  getSession?: typeof core.api.getSession;
  getSessionTranscript?: typeof core.api.getSessionTranscript;
  getSessionPending?: typeof core.api.getSessionPending;
  submitToSession?: typeof core.api.submitToSession;
  streamSession?: typeof core.api.streamSession;
  awaitSubmitOutcome?: typeof core.api.awaitSubmitOutcome | null;
  respond?: typeof core.api.respond;
  setPermissionMode?: typeof core.api.setPermissionMode;
}

/** A resolved ACP session and the /v0 target it proxies. */
interface ActiveSession {
  acpSessionId: string;
  cityName: string;
  v0SessionId: string;
  title: string | null;
}

/**
 * Concatenate the text of every non-`user` turn from `baseline` onward. Pure.
 * The user's own prompt echoes back as a `user` turn in the live snapshot; it is
 * dropped so the agent never re-emits what the operator just typed. (Mirrors
 * `assistantTextSince` in the VS Code chat participant bridge.)
 */
export function assistantTextSince(turns: readonly ConversationTurn[], baseline: number): string {
  return turns
    .slice(Math.max(0, baseline))
    .filter((turn) => turn.role !== "user")
    .map((turn) => turn.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * Append-only projector over the growing conversation. `next` takes each full
 * `turns` snapshot and returns only the assistant text not yet emitted, so the
 * adapter streams deltas (ACP `agent_message_chunk`) rather than re-sending the
 * whole reply. A rare mid-turn rewrite / shrink re-syncs silently.
 */
export class AssistantDelta {
  private emitted = "";

  constructor(private readonly baseline: number) {}

  next(turns: readonly ConversationTurn[]): string {
    const full = assistantTextSince(turns, this.baseline);
    if (full.length > this.emitted.length && full.startsWith(this.emitted)) {
      const delta = full.slice(this.emitted.length);
      this.emitted = full;
      return delta;
    }
    if (full.length > this.emitted.length) {
      this.emitted = full;
    }
    return "";
  }
}

/** Classify a /v0 respond action string into an ACP permission-option kind. */
function classifyOption(action: string): PermissionOption["kind"] {
  const a = action.toLowerCase();
  const always = /always/.test(a);
  if (/allow|approve|accept|yes|grant/.test(a)) {
    return always ? "allow_always" : "allow_once";
  }
  if (/deny|reject|no|cancel|decline/.test(a)) {
    return always ? "reject_always" : "reject_once";
  }
  // Unknown vocab: treat as an affirmative choice the user can still pick.
  return always ? "allow_always" : "allow_once";
}

/**
 * Map a /v0 pending interaction's `options` to ACP permission options. The
 * `optionId` is the verbatim /v0 action string so the operator's choice is
 * echoed straight back to `…/respond`. An interaction without options falls back
 * to the conventional allow/deny pair (the same default the chat webview uses).
 */
export function permissionOptionsFor(pending: PendingInteraction): PermissionOption[] {
  const actions = pending.options && pending.options.length > 0 ? pending.options : ["allow", "deny"];
  return actions.map((action) => ({
    optionId: action,
    name: action.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    kind: classifyOption(action),
  }));
}

/** Render a prompt-for-input as an assistant message (ACP has no mid-turn text prompt). */
export function describePromptForInput(pending: PendingInteraction): string {
  const lines = ["**The Mayor needs your input.**"];
  if (pending.prompt && pending.prompt.trim()) {
    lines.push("", pending.prompt.trim());
  }
  lines.push("", "_Reply with your answer to continue._");
  return lines.join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The ACP agent for the Mayor. Feed its {@link handleRequest} /
 * {@link handleNotification} to a {@link JsonRpcPeer}; it drives the /v0 session
 * through the injected `core.api` surface and streams updates back via `acp`.
 */
export class MayorAgent {
  private readonly d: Required<Omit<MayorAgentDeps, "awaitSubmitOutcome" | "config" | "client" | "endpoint" | "acp">> &
    Pick<MayorAgentDeps, "awaitSubmitOutcome">;
  private readonly client: CockpitClient;
  private readonly endpoint: StreamEndpoint;
  private readonly config: MayorConfig;
  private readonly acp: AcpClient;

  private resolvedCity: string | null = null;
  private sessionCounter = 0;
  private readonly sessions = new Map<string, ActiveSession>();
  /** In-flight turn controllers, keyed by ACP session id, for `session/cancel`. */
  private readonly turns = new Map<string, AbortController>();

  constructor(deps: MayorAgentDeps) {
    this.client = deps.client;
    this.endpoint = deps.endpoint;
    this.config = deps.config;
    this.acp = deps.acp;
    this.resolvedCity = deps.config.cityName ?? null;
    this.d = {
      listCities: deps.listCities ?? core.api.listCities,
      getSession: deps.getSession ?? core.api.getSession,
      getSessionTranscript: deps.getSessionTranscript ?? core.api.getSessionTranscript,
      getSessionPending: deps.getSessionPending ?? core.api.getSessionPending,
      submitToSession: deps.submitToSession ?? core.api.submitToSession,
      streamSession: deps.streamSession ?? core.api.streamSession,
      respond: deps.respond ?? core.api.respond,
      setPermissionMode: deps.setPermissionMode ?? core.api.setPermissionMode,
      awaitSubmitOutcome:
        deps.awaitSubmitOutcome === undefined ? core.api.awaitSubmitOutcome : deps.awaitSubmitOutcome,
    };
  }

  /** Dispatch an inbound ACP request to its result (throws {@link RpcError} on failure). */
  async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case METHOD_INITIALIZE:
        return this.initialize();
      case METHOD_AUTHENTICATE:
        return null; // No auth methods are advertised; nothing to do.
      case METHOD_SESSION_NEW:
        return this.newSession();
      case METHOD_SESSION_PROMPT:
        return this.prompt(params as PromptParams);
      case METHOD_SESSION_LOAD:
        throw new RpcError(RPC_METHOD_NOT_FOUND, "session/load is not supported (loadSession: false)");
      default:
        throw new RpcError(RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }
  }

  /** Dispatch an inbound ACP notification (no response). */
  handleNotification(method: string, params: unknown): void {
    if (method === METHOD_SESSION_CANCEL) {
      const sessionId = (params as CancelParams | undefined)?.sessionId;
      if (sessionId) {
        this.turns.get(sessionId)?.abort();
      }
    }
  }

  private initialize(): InitializeResult {
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
    };
  }

  /** Resolve the target city — explicit config, else the sole supervisor city. */
  private async resolveCity(): Promise<string> {
    if (this.resolvedCity) {
      return this.resolvedCity;
    }
    const cities = await this.d.listCities(this.client);
    if (!cities.ok) {
      throw new RpcError(RPC_INTERNAL_ERROR, `Could not list cities: ${cities.error.title}`);
    }
    const items = cities.data.items ?? [];
    if (items.length === 1) {
      this.resolvedCity = items[0].name;
      return this.resolvedCity;
    }
    if (items.length === 0) {
      throw new RpcError(RPC_INVALID_PARAMS, "No cities available from the supervisor; set --city.");
    }
    throw new RpcError(
      RPC_INVALID_PARAMS,
      `Supervisor serves ${items.length} cities (${items.map((c) => c.name).join(", ")}); set --city to choose one.`,
    );
  }

  private async newSession(): Promise<NewSessionResult> {
    const cityName = await this.resolveCity();
    const v0SessionId = this.config.mayorSession;

    const detail = await this.d.getSession(this.client, { cityName, id: v0SessionId });
    if (!detail.ok) {
      throw new RpcError(
        RPC_INVALID_PARAMS,
        `No session '${v0SessionId}' in city '${cityName}': ${detail.error.detail ?? detail.error.title}`,
      );
    }

    if (this.config.permissionMode) {
      // Best-effort: a provider that does not support modes shouldn't fail session/new.
      await this.d.setPermissionMode(this.client, cityName, v0SessionId, this.config.permissionMode);
    }

    const acpSessionId = `mayor-${cityName}-${++this.sessionCounter}`;
    this.sessions.set(acpSessionId, { acpSessionId, cityName, v0SessionId, title: detail.data.title ?? null });
    return { sessionId: acpSessionId };
  }

  private requireSession(acpSessionId: string): ActiveSession {
    const session = this.sessions.get(acpSessionId);
    if (!session) {
      throw new RpcError(RPC_INVALID_PARAMS, `Unknown session: ${acpSessionId}`);
    }
    return session;
  }

  /** Drive one ACP prompt turn to its stop reason. */
  private async prompt(params: PromptParams): Promise<PromptResult> {
    const session = this.requireSession(params?.sessionId);
    const text = contentBlocksToText(Array.isArray(params?.prompt) ? params.prompt : []).trim();
    if (!text) {
      throw new RpcError(RPC_INVALID_PARAMS, "Prompt contained no text content.");
    }

    const controller = new AbortController();
    this.turns.set(session.acpSessionId, controller);
    try {
      return { stopReason: await this.driveTurn(session, text, controller) };
    } finally {
      this.turns.delete(session.acpSessionId);
    }
  }

  /**
   * Submit (or answer a pending prompt-for-input), then project the live
   * per-session stream into `agent_message_chunk` updates until the turn settles.
   * Completion is event-driven: an `in-turn → idle` activity transition, the
   * stream closing, or the city-event outcome backstop — never a timer.
   */
  private async driveTurn(session: ActiveSession, text: string, controller: AbortController): Promise<StopReason> {
    const ref = { cityName: session.cityName, id: session.v0SessionId };

    // Baseline = the conversation length before this turn, so the delta projector
    // emits only the assistant text this turn produces.
    const transcript = await this.d.getSessionTranscript(this.client, { ...ref, format: "conversation" });
    const baseline = transcript.ok ? (transcript.data.turns ?? []).length : 0;

    // If the session is parked on a prompt-for-input, this prompt is the answer.
    const answered = await this.tryAnswerPendingInput(session, text);
    let correlation: { requestId: string; eventCursor?: string } | null = null;
    if (!answered) {
      const accepted = await this.d.submitToSession(this.client, { ...ref, message: text, intent: "default" });
      if (!accepted.ok) {
        throw new RpcError(RPC_INTERNAL_ERROR, accepted.error.detail ?? accepted.error.title);
      }
      correlation = {
        requestId: accepted.data.request_id,
        ...(accepted.data.event_cursor ? { eventCursor: accepted.data.event_cursor } : {}),
      };
    }

    const delta = new AssistantDelta(baseline);
    const handledPending = new Set<string>();
    let sawInTurn = false;
    let stop: StopReason | null = null;
    let cancelled = false;
    let failureNote: string | null = null;

    const emit = (turns: readonly ConversationTurn[]): void => {
      const chunk = delta.next(turns);
      if (chunk) {
        this.acp.sendUpdate(agentMessageChunk(session.acpSessionId, chunk));
      }
    };

    // Backstop: the city-event stream reports a terminal outcome even for
    // providers that never emit an idle activity. On any terminal outcome it
    // aborts the per-session stream so the loop below unwinds.
    const outcomeController = new AbortController();
    if (correlation && this.d.awaitSubmitOutcome) {
      void this.d
        .awaitSubmitOutcome(this.endpoint, { cityName: session.cityName, ...correlation }, { signal: outcomeController.signal })
        .then((outcome) => {
          if (outcome.kind === "failed") {
            failureNote = outcome.errorMessage;
          }
          if (outcome.kind !== "stream-ended") {
            stop ??= "end_turn";
            controller.abort();
          }
        })
        .catch(() => {
          /* best-effort — the live stream signals still settle the turn */
        });
    }

    try {
      for await (const event of this.d.streamSession(this.endpoint, ref, {
        signal: controller.signal,
        format: "conversation",
      })) {
        if (controller.signal.aborted) {
          break;
        }
        switch (event.kind) {
          case "turn":
            emit(event.turns);
            break;
          case "activity":
            if (event.activity === "in-turn") {
              sawInTurn = true;
            } else if (event.activity === "idle" && sawInTurn) {
              stop = "end_turn";
              controller.abort();
            }
            break;
          case "pending": {
            const handled = await this.handlePending(session, event.pending, handledPending);
            if (handled === "prompt-ended") {
              stop = "end_turn";
              controller.abort();
            } else if (handled === "cancelled") {
              cancelled = true;
              controller.abort();
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      // An aborted stream is the normal completion / cancel path; anything else is real.
      if (!controller.signal.aborted) {
        throw new RpcError(RPC_INTERNAL_ERROR, errorMessage(err));
      }
    } finally {
      outcomeController.abort();
    }

    if (cancelled) {
      stop = "cancelled";
    } else if (stop === null && controller.signal.aborted) {
      // Aborted with no internal completion reason recorded ⇒ a client session/cancel.
      stop = "cancelled";
    }
    if (failureNote) {
      this.acp.sendUpdate(agentMessageChunk(session.acpSessionId, `\n\n_The Mayor reported an error: ${failureNote}_`));
    }
    return stop ?? "end_turn";
  }

  /**
   * If the /v0 session is parked on a prompt-for-input, route `text` to it as the
   * answer (`…/respond` with the interaction's submit action). Returns true when
   * the prompt was consumed as an answer rather than a fresh submit.
   */
  private async tryAnswerPendingInput(session: ActiveSession, text: string): Promise<boolean> {
    const pending = await this.d.getSessionPending(this.client, session.cityName, session.v0SessionId);
    if (!pending.ok || !pending.data.pending || !core.api.isPromptForInput(pending.data.pending)) {
      return false;
    }
    const interaction = pending.data.pending;
    // For a prompt-for-input the action is the provider's submit token; the chat
    // store answers with `respond(<option|allow>, { text })`. Mirror that.
    const action = interaction.options && interaction.options.length > 0 ? interaction.options[0] : "allow";
    await this.d.respond(this.client, session.cityName, session.v0SessionId, {
      action,
      text,
      requestId: interaction.request_id,
    });
    return true;
  }

  /**
   * Handle a live `pending` interaction. A tool-approval becomes an ACP
   * `session/request_permission` whose outcome is forwarded to `…/respond`
   * (the turn continues). A prompt-for-input is surfaced as an assistant message
   * and ends the turn — the operator's next prompt answers it.
   */
  private async handlePending(
    session: ActiveSession,
    pending: PendingInteraction,
    handled: Set<string>,
  ): Promise<"continue" | "prompt-ended" | "cancelled"> {
    if (handled.has(pending.request_id)) {
      return "continue"; // A stale re-delivery of one we already answered.
    }
    handled.add(pending.request_id);

    if (core.api.isPromptForInput(pending)) {
      this.acp.sendUpdate(agentMessageChunk(session.acpSessionId, describePromptForInput(pending)));
      return "prompt-ended";
    }

    // Tool-approval → ask the client, forward their choice to /v0.
    const options = permissionOptionsFor(pending);
    const decision = await this.acp.requestPermission({
      sessionId: session.acpSessionId,
      toolCall: {
        toolCallId: pending.request_id,
        title: pending.prompt?.trim() || "The Mayor requests permission to act",
        kind: "other",
        status: "pending",
      },
      options,
    });

    if (decision.outcome.outcome === "selected") {
      await this.respondTo(session, pending.request_id, decision.outcome.optionId);
      return "continue";
    }

    // Cancelled: best-effort deny so the agent isn't left blocked, then stop.
    const denyOption = options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
    await this.respondTo(session, pending.request_id, denyOption?.optionId ?? "deny");
    return "cancelled";
  }

  private async respondTo(session: ActiveSession, requestId: string, action: string): Promise<ApiResult<unknown>> {
    return this.d.respond(this.client, session.cityName, session.v0SessionId, { action, requestId });
  }
}
