// The Webview ↔ extension-host message protocol for the chat panel (PRD Testing
// Decisions, Seam 2). Kept pure and `vscode`-free so it is unit-testable without
// an editor: given host state, `toViewState` produces exactly what the panel
// renders; given an incoming `postMessage`, `isWebviewToHost` validates it
// before the host acts. The panel (`chat-panel.ts`) is the thin glue that wires
// these to a real `vscode.Webview`.
import type { SubmitIntent } from "../api/index.ts";
import type {
  ConversationActivity,
  ConversationConnection,
  ConversationState,
} from "./conversation-store.ts";

/** A conversation turn, projected for the webview. */
export interface ChatTurnView {
  role: string;
  text: string;
  timestamp?: string;
}

/** A pending interaction, flattened for the webview. */
export interface ChatPendingView {
  kind: string;
  prompt: string;
  options: string[];
  requestId: string;
}

/**
 * A non-conversation overlay the chat surface shows instead of a transcript —
 * "connecting", "nothing here", or "load failed". Used by the docked Mayor chat
 * view (cockpit-dc8.1) before it is bound to a live session, so the pane never
 * ships blank. `tone` mirrors the shared {@link StateTone} vocabulary
 * (cockpit-1ll.19); `label`/`detail` carry the copy its helpers produce.
 */
export interface ChatNotice {
  tone: "loading" | "empty" | "error";
  label: string;
  detail?: string;
}

/**
 * The serializable view-model the webview renders. A flat projection of
 * {@link ConversationState} — no functions, no `undefined`-vs-missing ambiguity
 * for the fields the UI binds to — safe to `postMessage` across the host bridge.
 */
export interface ChatViewState {
  cityName: string;
  sessionId: string;
  title: string;
  provider: string | null;
  connection: ConversationConnection;
  activity: ConversationActivity;
  turns: ChatTurnView[];
  pending: ChatPendingView | null;
  capabilities: { followUp: boolean; interruptNow: boolean };
  permissionMode: string | null;
  sending: boolean;
  error: string | null;
  /**
   * A "no live conversation" overlay (connecting / empty / failed), or null when
   * a real conversation is being shown. A live store always projects `null` here
   * (see {@link toViewState}); only the docked view injects one via
   * {@link noticeViewState} while it resolves or loses its session.
   */
  notice: ChatNotice | null;
}

/** Project store state into the webview view-model. Pure. */
export function toViewState(state: ConversationState): ChatViewState {
  return {
    cityName: state.cityName,
    sessionId: state.sessionId,
    title: state.title ?? state.sessionId,
    provider: state.provider,
    connection: state.connection,
    activity: state.activity,
    turns: state.turns.map((turn) => ({
      role: turn.role,
      text: turn.text,
      ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
    })),
    pending: state.pending
      ? {
          kind: state.pending.kind,
          prompt: state.pending.prompt ?? "",
          options: state.pending.options ?? [],
          requestId: state.pending.request_id,
        }
      : null,
    capabilities: {
      followUp: state.capabilities?.supports_follow_up ?? false,
      interruptNow: state.capabilities?.supports_interrupt_now ?? false,
    },
    permissionMode: state.permissionMode,
    sending: state.sending,
    error: state.lastError,
    // A live conversation never overlays a notice; the docked view supplies one
    // only via noticeViewState when it has no store to project.
    notice: null,
  };
}

/**
 * Build a placeholder {@link ChatViewState} that carries a single
 * {@link ChatNotice} and no live conversation — what the docked Mayor chat view
 * shows before it is bound to a session (connecting to the supervisor, no Mayor
 * found, or a load failure). The webview renders the notice in place of the
 * transcript and disables the composer. Pure.
 */
export function noticeViewState(
  notice: ChatNotice,
  ref: { cityName?: string; sessionId?: string; title?: string } = {},
): ChatViewState {
  return {
    cityName: ref.cityName ?? "",
    sessionId: ref.sessionId ?? "",
    title: ref.title ?? ref.sessionId ?? "Mayor",
    provider: null,
    connection: notice.tone === "error" ? "error" : "idle",
    activity: "unknown",
    turns: [],
    pending: null,
    capabilities: { followUp: false, interruptNow: false },
    permissionMode: null,
    sending: false,
    error: null,
    notice,
  };
}

/** Messages the host pushes down to the webview. */
export type HostToWebview = { type: "state"; state: ChatViewState };

/** Messages the webview sends up to the host (operator actions). */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "submit"; message: string; intent: SubmitIntent }
  | { type: "respond"; action: string; text?: string }
  | { type: "setPermissionMode"; mode: string }
  | { type: "reconnect" };

/** The valid submit intents, for runtime validation of incoming messages. */
export const SUBMIT_INTENTS: readonly SubmitIntent[] = ["default", "follow_up", "interrupt_now"];

function isIntent(value: unknown): value is SubmitIntent {
  return typeof value === "string" && (SUBMIT_INTENTS as readonly string[]).includes(value);
}

/**
 * Validate an untrusted `postMessage` payload as a {@link WebviewToHost}. A
 * webview is a distinct trust/runtime boundary, so the host must not act on a
 * message without checking its shape first.
 */
export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "ready":
    case "reconnect":
      return true;
    case "submit":
      return typeof message.message === "string" && isIntent(message.intent);
    case "respond":
      return (
        typeof message.action === "string" &&
        (message.text === undefined || typeof message.text === "string")
      );
    case "setPermissionMode":
      return typeof message.mode === "string";
    default:
      return false;
  }
}
