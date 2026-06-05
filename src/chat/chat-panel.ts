// The VS Code editor glue for the chat panel. Intentionally thin (PRD: the
// editor-bound layer is small and excluded from heavy unit testing). All the
// logic worth testing lives behind the conversation store, the protocol
// projection, and the pure HTML builder; this just owns a `WebviewPanel`,
// bridges store state ⇄ webview messages, and cleans up.
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { ConversationStore, type ConversationState } from "./conversation-store.ts";
import { isWebviewToHost, toViewState, type HostToWebview } from "./protocol.ts";
import { getChatHtml } from "./webview-html.ts";

/** A 32-char nonce locking the webview's inline script to this load. */
function makeNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (const byte of randomBytes(32)) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

/**
 * A live chat panel bound to one {@link ConversationStore}. The store is owned
 * by the panel: disposing the panel disposes the store and tears down its
 * stream. Create with {@link ChatPanel.create}.
 */
export class ChatPanel {
  static readonly viewType = "gascityCockpit.chat";

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: ConversationStore,
  ) {
    panel.webview.html = getChatHtml({
      nonce: makeNonce(),
      cspSource: panel.webview.cspSource,
      title: store.state.title ?? store.state.sessionId,
    });
    this.disposables.push(
      store.onDidChange((state) => this.postState(state)),
      panel.webview.onDidReceiveMessage((message: unknown) => this.onMessage(message)),
      panel.onDidDispose(() => this.dispose()),
    );
    void store.start();
  }

  /** Open a chat panel for a session, beside the active editor by default. */
  static create(store: ConversationStore, options: { viewColumn?: vscode.ViewColumn } = {}): ChatPanel {
    const title = store.state.title ?? store.state.sessionId;
    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      `Chat · ${title}`,
      options.viewColumn ?? vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    return new ChatPanel(panel, store);
  }

  /** Bring the panel to the foreground. */
  reveal(): void {
    if (!this.disposed) {
      this.panel.reveal();
    }
  }

  private postState(state: ConversationState): void {
    if (this.disposed) {
      return;
    }
    if (state.title) {
      this.panel.title = `Chat · ${state.title}`;
    }
    const message: HostToWebview = { type: "state", state: toViewState(state) };
    void this.panel.webview.postMessage(message);
  }

  private onMessage(raw: unknown): void {
    if (!isWebviewToHost(raw)) {
      return;
    }
    switch (raw.type) {
      case "ready":
        this.postState(this.store.state);
        break;
      case "submit":
        void this.store.submit(raw.message, raw.intent);
        break;
      case "respond":
        void this.store.respond(raw.action, raw.text !== undefined ? { text: raw.text } : {});
        break;
      case "setPermissionMode":
        void this.store.setPermissionMode(raw.mode);
        break;
      case "reconnect":
        this.store.connect();
        break;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.store.dispose();
    this.panel.dispose();
  }
}
