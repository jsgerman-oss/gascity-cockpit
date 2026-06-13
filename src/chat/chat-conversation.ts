// The behavioural contract the chat surfaces (`ChatPanel`, `ChatViewProvider`)
// drive, independent of *what* is on the other end of the conversation. The
// cockpit `ConversationStore` (a gascity `/v0` session) satisfies it structurally;
// `GhostexConversationStore` (a Ghostex-hosted agent session) implements it
// explicitly. Both emit the same {@link ConversationState}, so the protocol
// projection (`toViewState`) and the webview render either source verbatim.
//
// Type-only (no runtime): it exists so a panel can hold "some conversation"
// without binding to a concrete backend, which is what lets a Ghostex agent
// session be a chat target alongside a Mayor session.
import type { SubmitIntent } from "../api/index.ts";
import type { Disposable } from "../discovery/index.ts";
import type { ConversationState } from "./conversation-store.ts";

/**
 * The minimal acknowledgement a chat action resolves to. The cockpit store's
 * richer `ApiResult<…>` returns are assignable to this (they all carry `ok`),
 * so `ConversationStore` satisfies {@link ChatConversation} without changes;
 * the Ghostex store returns this shape directly.
 */
export interface ChatActionResult {
  readonly ok: boolean;
}

/** A conversation a chat surface can render and drive, whatever its backend. */
export interface ChatConversation {
  /** Current immutable state snapshot (what the panel projects + renders). */
  readonly state: ConversationState;
  /** Subscribe to state changes; returns a disposable that unsubscribes. */
  onDidChange(listener: (state: ConversationState) => void): Disposable;
  /** Load a snapshot then open the live stream. */
  start(): Promise<void>;
  /** (Re)open the live stream without reloading the snapshot. */
  connect(): void;
  /** Send an operator message into the conversation. */
  submit(message: string, intent?: SubmitIntent): Promise<ChatActionResult>;
  /** Answer a pending tool-approval / prompt-for-input (no-op where unsupported). */
  respond(
    action: string,
    options?: { text?: string; metadata?: Record<string, string> },
  ): Promise<ChatActionResult>;
  /** Set the conversation's permission mode (no-op where unsupported). */
  setPermissionMode(mode: string): Promise<ChatActionResult>;
  /** Tear down the stream and release resources. */
  dispose(): void;
}
