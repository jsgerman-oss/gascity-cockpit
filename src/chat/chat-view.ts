// The VS Code editor glue for the *docked* Mayor chat — a WebviewView pinned in
// the GasCity Cockpit container, present by default (cockpit-dc8.1), as opposed
// to the pop-out ChatPanel (`chat-panel.ts`). Like the panel it is intentionally
// thin: every bit of conversation logic lives behind the vscode-free
// ConversationStore / protocol projection / HTML builder. The provider's only
// jobs are to (a) keep one webview wired to one store, (b) resolve which session
// that store talks to — the active city's Mayor by default, or any city/session
// the operator picks via the shared chat picker — and (c) survive the supervisor
// connecting/disconnecting by rebinding, never going blank (it falls back to a
// connecting/empty/error notice built from the shared view-state copy).
import * as vscode from "vscode";
import * as path from "node:path";
import { listCities, listSessions, type CockpitClient } from "../api/index.ts";
import type { ApiEndpoint, ConnectionStatus, Logger } from "../discovery/index.ts";
import { CONNECTING, emptyNotice, errorNotice, loadingNotice } from "../ui/index.ts";
import { rankCitiesForPicker } from "./city-picker.ts";
import { rankSessionsForChat } from "./session-picker.ts";
import { ConversationStore, type ConversationState } from "./conversation-store.ts";
import { makeNonce } from "./chat-panel.ts";
import { pickCity, pickSession } from "./open-chat.ts";
import {
  isWebviewToHost,
  noticeViewState,
  toViewState,
  type ChatNotice,
  type ChatViewState,
  type HostToWebview,
} from "./protocol.ts";
import { getChatHtml } from "./webview-html.ts";

/** A bound chat target: which session, in which city. */
interface ChatTarget {
  cityName: string;
  sessionId: string;
}

/**
 * The slice of the cockpit host the docked chat view needs — connection state
 * and the typed client. The full {@link FeatureHost} satisfies it structurally,
 * so the feature passes the host straight through; declaring the minimal surface
 * here keeps `src/chat` free of a hard dependency on `src/host`.
 */
export interface ChatViewHost {
  readonly context: vscode.ExtensionContext;
  readonly log: Logger;
  getClient(): CockpitClient | null;
  getEndpoint(): ApiEndpoint | null;
  onStatusChange(listener: (status: ConnectionStatus) => void): vscode.Disposable;
}

/** workspaceState key persisting an operator-chosen target across reloads. */
const TARGET_KEY = "gascityCockpit.chatView.target";

/** Command id of the pop-out chat panel (registered by the `chat` feature). */
const OPEN_CHAT_COMMAND = "gascityCockpit.openChat";

/**
 * Provides the docked Mayor chat WebviewView. One instance is registered per
 * activation; it owns at most one {@link ConversationStore} at a time and rebinds
 * it as the connection or the chosen target changes.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  /** Must match the `id` of the contributed view (`chatView.contributes.json`). */
  static readonly viewType = "gascityCockpit.chatView";

  private view: vscode.WebviewView | null = null;
  private store: ConversationStore | null = null;
  private storeSub: vscode.Disposable | null = null;
  private readonly viewSubs: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  /** The current binding. An `explicit` target (operator picked) persists and survives rebinds. */
  private target: ChatTarget | null = null;
  private explicitTarget = false;
  /** Dedupe key of the endpoint the live store is bound to (mirrors the status feature). */
  private endpointKey: string | null = null;
  /** True while an async default-target resolution is in flight (dedupes concurrent triggers). */
  private resolving = false;
  private disposed = false;

  constructor(private readonly host: ChatViewHost) {
    const saved = host.context.workspaceState.get<ChatTarget>(TARGET_KEY);
    if (saved && saved.cityName && saved.sessionId) {
      this.target = saved;
      this.explicitTarget = true;
    }
    this.disposables.push(host.onStatusChange((status) => this.applyStatus(status)));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getChatHtml({
      nonce: makeNonce(),
      cspSource: view.webview.cspSource,
      title: this.target?.sessionId ?? "Mayor",
    });
    this.viewSubs.push(
      view.webview.onDidReceiveMessage((message: unknown) => this.onMessage(message)),
      view.onDidDispose(() => this.onViewDisposed()),
    );
    // The webview answers `ready` on load, but resolve can also happen with the
    // script already alive (retainContextWhenHidden), so push current state now.
    this.refresh();
  }

  /** Pop the current conversation out into the full ChatPanel (bead: title-bar action). */
  async popOut(): Promise<void> {
    await vscode.commands.executeCommand(OPEN_CHAT_COMMAND, this.target ?? undefined);
  }

  /** Switch the docked view to another city/session via the shared chat picker (multi-city). */
  async switchTarget(): Promise<void> {
    const client = this.host.getClient();
    const endpoint = this.host.getEndpoint();
    if (!client || !endpoint) {
      void vscode.window.showInformationMessage(
        "GasCity Cockpit: not connected to a supervisor yet.",
      );
      return;
    }
    const cityName = await pickCity(client, this.host.log);
    if (!cityName) return;
    const sessionId = await pickSession(client, cityName, this.host.log);
    if (!sessionId) return;
    this.setTarget({ cityName, sessionId }, true);
    this.bind(client, endpoint, { cityName, sessionId });
  }

  // ---- binding lifecycle -------------------------------------------------

  /** Push the current state to the webview: the live store's, or (re)bind one. */
  private refresh(): void {
    if (!this.view) return;
    if (this.store) {
      this.post(toViewState(this.store.state));
      return;
    }
    void this.ensureBound();
  }

  /** Bind a store for the current target, resolving the default (the Mayor) if none is set. */
  private async ensureBound(): Promise<void> {
    if (this.disposed || this.store || !this.view) return;
    const client = this.host.getClient();
    const endpoint = this.host.getEndpoint();
    if (!client || !endpoint) {
      this.postNotice(loadingNotice(CONNECTING));
      return;
    }
    if (this.target) {
      this.bind(client, endpoint, this.target);
      return;
    }
    if (this.resolving) return;
    this.resolving = true;
    this.postNotice(loadingNotice(CONNECTING));
    try {
      const target = await this.resolveDefaultTarget(client);
      if (this.disposed || !this.view || this.store) return; // superseded
      if (!target) {
        this.postNotice(
          emptyNotice("No Mayor session yet", "Start a city, or use Switch to pick a session."),
        );
        return;
      }
      this.setTarget(target, false);
      // Re-read the connection — it may have changed across the await.
      const client2 = this.host.getClient();
      const endpoint2 = this.host.getEndpoint();
      if (client2 && endpoint2) this.bind(client2, endpoint2, target);
    } finally {
      this.resolving = false;
    }
  }

  /** Resolve the default chat target: the Mayor of the active (workspace / first running) city. */
  private async resolveDefaultTarget(client: CockpitClient): Promise<ChatTarget | null> {
    const preferred = this.workspaceCity();
    let cityName = preferred;
    const cities = await listCities(client);
    if (cities.ok) {
      const ranked = rankCitiesForPicker(cities.data.items ?? [], preferred);
      if (ranked.length) cityName = ranked[0].name;
    }
    if (!cityName) return null;
    const sessions = await listSessions(client, { cityName, peek: false });
    if (!sessions.ok) return null;
    const ranked = rankSessionsForChat(sessions.data.items ?? []);
    if (!ranked.length) return null;
    // rankSessionsForChat floats the Mayor to the front, so the head is the default.
    return { cityName, sessionId: ranked[0].id };
  }

  private bind(client: CockpitClient, endpoint: ApiEndpoint, target: ChatTarget): void {
    this.teardownStore();
    this.endpointKey = endpointKey(endpoint);
    const store = new ConversationStore({
      client,
      endpoint,
      cityName: target.cityName,
      sessionId: target.sessionId,
    });
    this.store = store;
    this.storeSub = store.onDidChange((state) => this.onStoreChange(state));
    if (this.view) this.view.description = target.cityName;
    this.post(toViewState(store.state)); // immediate (loading) state — never blank
    void store.start();
  }

  private onStoreChange(state: ConversationState): void {
    this.post(toViewState(state));
  }

  private setTarget(target: ChatTarget, explicit: boolean): void {
    this.target = target;
    this.explicitTarget = explicit;
    // Only an operator's explicit pick is worth remembering across reloads; an
    // auto-resolved default should re-resolve to the current Mayor next time.
    if (explicit) void this.host.context.workspaceState.update(TARGET_KEY, target);
  }

  // ---- status reactions --------------------------------------------------

  private applyStatus(status: ConnectionStatus): void {
    if (this.disposed || !this.view) return;
    const ep = status.endpoint;
    if (status.state === "connected" && ep) {
      const key = endpointKey(ep);
      if (status.restarted || key !== this.endpointKey) {
        this.teardownStore();
        // A fresh/restarted supervisor: re-resolve the Mayor unless the operator
        // pinned a specific session.
        if (!this.explicitTarget) this.target = null;
        void this.ensureBound();
      }
    } else if (status.state === "unavailable" || status.state === "idle") {
      this.teardownStore();
      this.endpointKey = null;
      this.postNotice(
        status.state === "unavailable"
          ? errorNotice("the Mayor chat", "Supervisor API unavailable")
          : loadingNotice(CONNECTING),
      );
    }
  }

  // ---- webview bridge ----------------------------------------------------

  private onMessage(raw: unknown): void {
    if (!isWebviewToHost(raw)) return;
    switch (raw.type) {
      case "ready":
        this.refresh();
        break;
      case "submit":
        void this.store?.submit(raw.message, raw.intent);
        break;
      case "respond":
        void this.store?.respond(raw.action, raw.text !== undefined ? { text: raw.text } : {});
        break;
      case "setPermissionMode":
        void this.store?.setPermissionMode(raw.mode);
        break;
      case "reconnect":
        if (this.store) this.store.connect();
        else void this.ensureBound();
        break;
    }
  }

  private post(state: ChatViewState): void {
    if (!this.view) return;
    const message: HostToWebview = { type: "state", state };
    void this.view.webview.postMessage(message);
  }

  private postNotice(notice: ChatNotice): void {
    if (this.view) this.view.description = undefined;
    this.post(noticeViewState(notice, this.target ?? {}));
  }

  // ---- teardown ----------------------------------------------------------

  /** The open workspace folder's basename — the default city guess. */
  private workspaceCity(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder && folder.uri.scheme === "file" ? path.basename(folder.uri.fsPath) : "";
  }

  private onViewDisposed(): void {
    for (const sub of this.viewSubs.splice(0)) sub.dispose();
    this.teardownStore();
    this.view = null;
  }

  private teardownStore(): void {
    this.storeSub?.dispose();
    this.storeSub = null;
    this.store?.dispose();
    this.store = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onViewDisposed();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

/** Stable dedupe key for an endpoint (base URL + token), matching the status feature. */
function endpointKey(ep: { baseUrl: string; token?: string | null }): string {
  return `${ep.baseUrl}::${ep.token ?? ""}`;
}
