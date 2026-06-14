/**
 * Ghostex chat — the editor glue (PRD "Seam 1": thin, `vscode`-bound, excluded
 * from coverage). It wires the `vscode`-free bridge core
 * (`../ghostex/chatBridge.ts`) to the live world and the *existing* chat webview:
 *
 *   - `…ghostex.session.chat` — chat with a Ghostex-hosted agent session. Invoked
 *     from the Sessions explorer's agent rows (the session is the menu's tree
 *     node), or from the command palette (which lists the city's agent sessions
 *     in a QuickPick). It connects to gxserver, opens a chat panel reusing the
 *     Mayor-chat webview (`getChatHtml` + the `WebviewToHost`/`HostToWebview`
 *     protocol), and binds a {@link GhostexChatStore}: submit → `sendSessionMessage`,
 *     output ← `readSessionText` driven by the `/api/events` stream + a poll.
 *
 * All the testable logic — the store's state machine, the chat-view projection,
 * and the agent-session ranking/labelling — lives in the core; this file only
 * discovers gxserver, picks a session, owns the `WebviewPanel`, and bridges store
 * state ⇄ webview messages. Mirrors `../chat/chat-panel.ts` (the Mayor panel) and
 * the discovery/WebSocket wiring in `./ghostexExplorer.ts`.
 */
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  discoverGhostex,
  GhostexChatStore,
  GhostexEventStream,
  ghostexChatPickLabel,
  GxClient,
  rankGhostexSessionsForChat,
  toGhostexChatViewState,
  type GhostexChatState,
  type GhostexDiscoveryInputs,
  type GhostexEvent,
  type GhostexLogger,
  type GhostexSessionActivity,
  type GhostexTreeNode,
  type WebSocketFactory,
  type WebSocketLike,
} from '../ghostex/index.ts';
import { getChatHtml, isWebviewToHost, type HostToWebview } from '../chat/index.ts';
import { makeNonce } from '../chat/chat-panel.ts';
import { CONFIG_SECTION, type FeatureHost } from '../host/index.ts';

const CMD = {
  chat: 'gascityCockpit.ghostex.session.chat',
} as const;

/** A resolved chat target: the session and what we already know about it. */
interface ChatTarget {
  readonly sessionId: string;
  readonly title?: string;
  readonly agentId?: string;
  readonly activity?: GhostexSessionActivity;
}

/** A live gxserver endpoint (base URL + bearer token). */
interface Endpoint {
  readonly baseUrl: string;
  readonly token: string | null;
}

/** Register the Ghostex chat command. Invoked from the Sessions explorer + palette. */
export function registerGhostexChat(host: FeatureHost): void {
  host.context.subscriptions.push(
    vscode.commands.registerCommand(CMD.chat, (node?: GhostexTreeNode) => chat(host, node)),
  );
}

async function chat(host: FeatureHost, node?: GhostexTreeNode): Promise<void> {
  const endpoint = await connect(host);
  if (!endpoint) return;
  const client = GxClient.rpc(endpoint);

  const target = targetFromNode(node) ?? (await pickAgentSession(client, host));
  if (!target) return;

  GhostexChatPanel.create(host, endpoint, client, target);
}

// --- target resolution ------------------------------------------------------

/** Seed a target from an explorer session row (carries title/agent/activity). */
function targetFromNode(node?: GhostexTreeNode): ChatTarget | null {
  if (node?.kind !== 'session') return null;
  const s = node.session;
  return {
    sessionId: s.sessionId,
    title: s.title,
    ...(s.agentId ? { agentId: s.agentId } : {}),
    activity: s.activity,
  };
}

/** List the city's Ghostex agent sessions and let the operator pick one to chat with. */
async function pickAgentSession(client: GxClient, host: FeatureHost): Promise<ChatTarget | null> {
  let sessions;
  try {
    sessions = await client.listSessions();
  } catch (err) {
    host.log('warn', 'ghostex chat: could not list sessions', { error: String(err) });
    void vscode.window.showErrorMessage(`Ghostex: could not list sessions — ${errText(err)}`);
    return null;
  }

  const agents = rankGhostexSessionsForChat(sessions);
  if (agents.length === 0) {
    void vscode.window.showInformationMessage(
      'No Ghostex agent sessions to chat with — launch an agent in Ghostex first.',
    );
    return null;
  }

  const pick = await vscode.window.showQuickPick(agents.map(ghostexChatPickLabel), {
    title: 'Ghostex: Chat with Session',
    placeHolder: 'Select a Ghostex agent session (running sessions first)',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return null;

  const chosen = agents.find((s) => s.sessionId === pick.id);
  if (!chosen) return null;
  return {
    sessionId: chosen.sessionId,
    title: chosen.title,
    ...(chosen.agentId ? { agentId: chosen.agentId } : {}),
  };
}

// --- the panel --------------------------------------------------------------

/**
 * A live chat panel bound to one {@link GhostexChatStore}, rendered with the
 * shared chat webview. The store (and its events stream) is owned by the panel:
 * disposing the panel disposes the store, which tears down the subscription and
 * the poll.
 */
class GhostexChatPanel {
  static readonly viewType = 'gascityCockpit.ghostexChat';

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: GhostexChatStore,
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

  /** Connect a store to gxserver for `target` and open its chat panel. */
  static create(host: FeatureHost, endpoint: Endpoint, client: GxClient, target: ChatTarget): GhostexChatPanel {
    const stream = buildEventStream(host, endpoint);
    const store = new GhostexChatStore({
      client,
      sessionId: target.sessionId,
      session: {
        ...(target.title ? { title: target.title } : {}),
        ...(target.agentId ? { agentId: target.agentId } : {}),
        ...(target.activity ? { activity: target.activity } : {}),
      },
      pollIntervalMs: pollIntervalMs(),
      // When the runtime has a WebSocket, stream presentation deltas; the store
      // owns start/stop via this subscribe seam. Absent → poll-only.
      ...(stream
        ? {
            subscribe: (listener: (event: GhostexEvent) => void) => {
              stream.onEventListener = listener;
              stream.start();
              return () => {
                stream.onEventListener = () => {};
                stream.stop();
              };
            },
          }
        : {}),
    });

    const title = target.title || target.sessionId;
    const panel = vscode.window.createWebviewPanel(
      GhostexChatPanel.viewType,
      `Ghostex · ${title}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    return new GhostexChatPanel(panel, store);
  }

  private postState(state: GhostexChatState): void {
    if (this.disposed) return;
    if (state.title) this.panel.title = `Ghostex · ${state.title}`;
    const message: HostToWebview = { type: 'state', state: toGhostexChatViewState(state) };
    void this.panel.webview.postMessage(message);
  }

  private onMessage(raw: unknown): void {
    if (!isWebviewToHost(raw)) return;
    switch (raw.type) {
      case 'ready':
        this.postState(this.store.state);
        break;
      case 'submit':
        void this.store.submit(raw.message);
        break;
      case 'reconnect':
        this.store.connect();
        break;
      // A Ghostex terminal session has no pending approvals or permission mode —
      // the webview never raises `respond` / `setPermissionMode` for it; ignore.
      case 'respond':
      case 'setPermissionMode':
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.store.dispose(); // stops the events stream + poll via the subscribe teardown
    this.panel.dispose();
  }
}

// --- gxserver wiring --------------------------------------------------------

/** Discover gxserver and return a live endpoint, surfacing an actionable error when unavailable. */
async function connect(host: FeatureHost): Promise<Endpoint | null> {
  const discovery = await discoverGhostex(discoveryInputs());
  if (discovery.state !== 'connected') {
    host.log('warn', 'ghostex chat: gxserver unavailable', { reason: discovery.reason });
    void vscode.window.showErrorMessage(`Ghostex unavailable — ${discovery.detail}`);
    return null;
  }
  return { baseUrl: discovery.endpoint.baseUrl, token: discovery.endpoint.token };
}

/**
 * A self-healing events stream for the chat panel, or `null` when the runtime has
 * no `WebSocket` (then the store polls). The `onEventListener` indirection lets the
 * store's subscribe seam own start/stop while the stream is constructed up front.
 */
interface ChatEventStream {
  onEventListener: (event: GhostexEvent) => void;
  start(): void;
  stop(): void;
}

function buildEventStream(host: FeatureHost, endpoint: Endpoint): ChatEventStream | null {
  const createWebSocket = webSocketFactory(host.log);
  if (!createWebSocket) return null;
  let listener: (event: GhostexEvent) => void = () => {};
  const stream = new GhostexEventStream({
    baseUrl: endpoint.baseUrl,
    token: endpoint.token,
    createWebSocket,
    baseDelayMs: config().get<number>('ghostex.reconnectBackoffMs', 500),
    log: (level, message, meta) => host.log(level, message, meta),
    onEvent: (event) => listener(event),
  });
  return {
    set onEventListener(fn: (event: GhostexEvent) => void) {
      listener = fn;
    },
    start: () => stream.start(),
    stop: () => stream.stop(),
  };
}

// --- config + helpers -------------------------------------------------------

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function pollIntervalMs(): number {
  return Math.max(1, config().get<number>('ghostex.chatPollSeconds', 2)) * 1000;
}

function discoveryInputs(): GhostexDiscoveryInputs {
  const cfg = config();
  const url = cfg.get<string>('ghostex.gxserverUrl', '').trim();
  const token = cfg.get<string>('ghostex.gxserverToken', '').trim();
  return {
    settingsUrl: url || null,
    settingsToken: token || null,
    readTokenFile: (path) => readFile(expandHome(path), 'utf8'),
  };
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~(?=$|[/\\])/, homedir()) : p;
}

/** Adapt the runtime's global `WebSocket` to the stream's injected-socket shape (or null). */
function webSocketFactory(log: GhostexLogger): WebSocketFactory | null {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (typeof Ctor !== 'function') {
    log('warn', 'ghostex chat: no WebSocket in this runtime — output will poll instead of streaming');
    return null;
  }
  return (url: string) => new Ctor(url);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
