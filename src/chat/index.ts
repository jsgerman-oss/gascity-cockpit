// Public surface of the chat-with-Mayor feature.
//
// The extension entry point imports from here; the store / protocol / HTML
// builder are the testable seams (vscode-free), and `chat-panel.ts` is the thin
// editor glue.
export {
  ConversationStore,
  type ConversationActivity,
  type ConversationConnection,
  type ConversationState,
  type ConversationStoreDeps,
} from "./conversation-store.ts";
export {
  isWebviewToHost,
  toViewState,
  noticeViewState,
  SUBMIT_INTENTS,
  type ChatNotice,
  type ChatPendingView,
  type ChatTurnView,
  type ChatViewState,
  type HostToWebview,
  type WebviewToHost,
} from "./protocol.ts";
export { getChatHtml, escapeHtml, type ChatHtmlOptions } from "./webview-html.ts";
export { ChatPanel } from "./chat-panel.ts";
export { ChatViewProvider, type ChatViewHost } from "./chat-view.ts";
export type { ChatConversation, ChatActionResult } from "./chat-conversation.ts";
export {
  isLikelyMayor,
  rankSessionsForChat,
  sessionPickLabel,
  type SessionPickLabel,
} from "./session-picker.ts";
export { openChat, type OpenChatArgs } from "./open-chat.ts";
export {
  GhostexConversationStore,
  composeGhostexTurns,
  ghostexActivityToConversation,
  type GhostexChatClient,
  type GhostexConversationStoreDeps,
  type GhostexEventSubscribe,
} from "./ghostex-conversation-store.ts";
export {
  isAgentSession,
  rankGhostexAgentSessions,
  ghostexSessionPickLabel,
  type GhostexSessionPickLabel,
} from "./ghostex-session-picker.ts";
export { openGhostexChat, type OpenGhostexChatArgs } from "./open-ghostex-chat.ts";
