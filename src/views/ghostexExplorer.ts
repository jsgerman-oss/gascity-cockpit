/**
 * VS Code glue for the Ghostex Sessions explorer — the projects→sessions tree an
 * operator drives Ghostex from. Intentionally thin (PRD "Seam 1"): every testable
 * behaviour — the snapshot model, delta application, tree shape, and the
 * activity/lifecycle presentation — lives in the `vscode`-free
 * `../ghostex/explorerModel.ts` core; this file maps that core onto a
 * {@link vscode.TreeDataProvider}, wires the live data (an initial
 * `readPresentationSnapshot()` plus deltas from the gxserver `/api/events`
 * stream, with a `pollSeconds` liveness re-probe), and registers the explorer's
 * commands. Mirrors `src/views/beadsExplorer.ts`.
 *
 * Command ownership (the explorer is one of two parallel "sessions" beads):
 *   - Owned + registered here: refresh, checkConnection, showOutput, and
 *     `…session.copyRef` (a self-contained clipboard action).
 *   - The drive actions a context menu routes into — focus / sleep / wake /
 *     kill / send / read on a session, new (agent) session on a project — are
 *     *declared* here (so the menus are valid) but their **handlers are
 *     registered by the Ghostex drive-commands feature**. The two compose on the
 *     `integration` branch; the menu item passes the tree node, whose
 *     `session.sessionId` / `projectId` the drive command reads.
 */
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  discoverGhostex,
  GhostexEventStream,
  GhostexExplorerModel,
  GxClient,
  probeGhostexHealth,
  type GhostexDiscovery,
  type GhostexDiscoveryInputs,
  type GhostexLogger,
  type GhostexProjectNode,
  type GhostexSessionNode,
  type GhostexTreeNode,
  type WebSocketFactory,
  type WebSocketLike,
} from '../ghostex/index.ts';
import { openGhostexChat } from '../chat/open-ghostex-chat.ts';
import { CONFIG_SECTION, type FeatureHost } from '../host/index.ts';

/** The Sessions view id (was the placeholder's; the real tree now owns it). */
export const GHOSTEX_VIEW_ID = 'gascityCockpitGhostex.sessions';

const CMD = {
  refresh: 'gascityCockpit.ghostex.refresh',
  checkConnection: 'gascityCockpit.ghostex.checkConnection',
  showOutput: 'gascityCockpit.ghostex.showOutput',
  chat: 'gascityCockpit.ghostex.chat',
  copyRef: 'gascityCockpit.ghostex.session.copyRef',
} as const;

// --- Tree data provider -----------------------------------------------------

class GhostexSessionsProvider implements vscode.TreeDataProvider<GhostexTreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly model = new GhostexExplorerModel();

  getTreeItem(node: GhostexTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'message':
        return messageItem(node);
      case 'project':
        return projectItem(node);
      case 'session':
        return sessionItem(node);
    }
  }

  getChildren(node?: GhostexTreeNode): GhostexTreeNode[] {
    return node ? this.model.childrenOf(node) : this.model.roots();
  }

  /** Repaint the whole tree (the model is small; a targeted refresh isn't worth it). */
  repaint(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function messageItem(node: Extract<GhostexTreeNode, { kind: 'message' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.id = node.id;
  item.contextValue = 'ghostexMessage';
  item.description = node.detail;
  item.tooltip = node.detail;
  item.iconPath = themeIcon(node.icon, node.iconColor);
  return item;
}

function projectItem(node: GhostexProjectNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.Expanded);
  item.id = node.id;
  item.contextValue = 'ghostexProject';
  item.description = node.sessionCount === 0 ? 'no sessions' : `${node.runningCount}/${node.sessionCount}`;
  item.iconPath = projectIcon(node);
  item.tooltip = node.path ? `${node.title}\n${node.path}` : node.title;
  return item;
}

function sessionItem(node: GhostexSessionNode): vscode.TreeItem {
  const p = node.presentation;
  const item = new vscode.TreeItem(p.label, vscode.TreeItemCollapsibleState.None);
  item.id = node.id;
  item.contextValue = p.contextValue;
  item.description = p.description;
  item.iconPath = themeIcon(p.icon, p.iconColor);
  item.tooltip = new vscode.MarkdownString(p.tooltip);
  item.accessibilityInformation = { label: p.accessibleLabel };
  // No default click command: the drive actions live in the context menu (wired
  // by the drive-commands feature on the integration branch). Selecting a row is
  // enough; a default that pointed at a not-yet-registered command would error.
  return item;
}

function projectIcon(node: GhostexProjectNode): vscode.ThemeIcon {
  if (node.attentionCount > 0) return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground'));
  if (node.runningCount > 0) return new vscode.ThemeIcon('server-environment');
  return new vscode.ThemeIcon('folder');
}

function themeIcon(icon: string, color?: string): vscode.ThemeIcon {
  return color ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(color)) : new vscode.ThemeIcon(icon);
}

// --- Live data controller ---------------------------------------------------

/**
 * Owns the live link behind the provider's model: discovery → initial snapshot →
 * the events stream (instant deltas) + a `pollSeconds` health re-probe (liveness,
 * and the snapshot refetch when the runtime has no WebSocket). Fully disposable.
 */
class GhostexLiveController {
  private stream: GhostexEventStream | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private client: GxClient | null = null;
  private endpoint: { baseUrl: string; token: string | null } | null = null;
  private disposed = false;

  constructor(
    private readonly host: FeatureHost,
    private readonly provider: GhostexSessionsProvider,
  ) {}

  /** (Re)establish the link: discover, load the snapshot, start live updates. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const discovery = await this.discover();
    if (discovery.state !== 'connected') {
      this.teardownLive();
      if (this.provider.model.setConnState('unavailable', discovery.detail)) this.provider.repaint();
      return;
    }
    this.endpoint = { baseUrl: discovery.endpoint.baseUrl, token: discovery.endpoint.token };
    this.client = GxClient.rpc(this.endpoint);
    await this.loadSnapshot();
    this.startStream();
    this.startPoll();
  }

  private async loadSnapshot(): Promise<void> {
    if (!this.client) return;
    try {
      this.provider.model.seed(await this.client.readPresentationSnapshot());
    } catch (err) {
      this.provider.model.setConnState('unavailable', errMessage(err));
    }
    this.provider.repaint();
  }

  private startStream(): void {
    this.stopStream();
    if (!this.endpoint) return;
    const createWebSocket = webSocketFactory(this.host.log);
    if (!createWebSocket) return; // no WebSocket runtime → poll-only mode
    this.stream = new GhostexEventStream({
      baseUrl: this.endpoint.baseUrl,
      token: this.endpoint.token,
      createWebSocket,
      baseDelayMs: config().get<number>('ghostex.reconnectBackoffMs', 500),
      log: (level, message, meta) => this.host.log(level, message, meta),
      onEvent: (event) => {
        if (this.provider.model.applyEvent(event)) this.provider.repaint();
      },
    });
    this.stream.start();
  }

  private startPoll(): void {
    this.stopPoll();
    const ms = Math.max(2, config().get<number>('ghostex.pollSeconds', 10)) * 1000;
    this.pollTimer = setInterval(() => void this.pollTick(), ms);
  }

  /**
   * One liveness tick. A failed probe degrades the pane to "reconnecting"; a
   * healthy probe resyncs the snapshot when we were degraded, or — in poll-only
   * mode (no live stream) — every tick, so the tree stays current without deltas.
   */
  private async pollTick(): Promise<void> {
    if (this.disposed || !this.endpoint) return;
    try {
      await probeGhostexHealth(this.endpoint.baseUrl, { token: this.endpoint.token });
    } catch (err) {
      if (this.provider.model.setConnState('reconnecting', errMessage(err))) this.provider.repaint();
      return;
    }
    const wasDegraded = this.provider.model.connState !== 'connected';
    if (!this.stream || wasDegraded) await this.loadSnapshot();
  }

  private stopStream(): void {
    this.stream?.dispose();
    this.stream = null;
  }

  private stopPoll(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private teardownLive(): void {
    this.stopStream();
    this.stopPoll();
  }

  /** Probe gxserver, tolerating a thrown discovery into a typed `unavailable`. */
  private async discover(): Promise<GhostexDiscovery> {
    try {
      return await discoverGhostex(discoveryInputs());
    } catch (err) {
      this.host.log('error', 'ghostex: discovery threw', { error: String(err) });
      return { state: 'unavailable', reason: 'unreachable', detail: `Ghostex discovery failed: ${String(err)}`, baseUrl: '' };
    }
  }

  dispose(): void {
    this.disposed = true;
    this.teardownLive();
  }
}

// --- Registration -----------------------------------------------------------

/** Register the Ghostex Sessions explorer (replacing the foundation placeholder). */
export function registerGhostexExplorer(host: FeatureHost): { refresh: () => void } {
  const provider = new GhostexSessionsProvider();
  const view = vscode.window.createTreeView(GHOSTEX_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const controller = new GhostexLiveController(host, provider);

  host.context.subscriptions.push(
    view,
    provider,
    { dispose: () => controller.dispose() },
    vscode.commands.registerCommand(CMD.refresh, () => void controller.refresh()),
    vscode.commands.registerCommand(CMD.checkConnection, async () => {
      await controller.refresh();
      if (provider.model.connState === 'connected') {
        void vscode.window.showInformationMessage('Ghostex connected.');
      } else {
        void vscode.window.showWarningMessage('Ghostex unavailable — see the Ghostex output for details.');
      }
    }),
    vscode.commands.registerCommand(CMD.showOutput, () => host.showOutput()),
    vscode.commands.registerCommand(CMD.chat, () =>
      openGhostexChat({
        log: host.log,
        discoveryInputs,
        pollMs: Math.max(2, config().get<number>('ghostex.pollSeconds', 10)) * 1000,
      }),
    ),
    vscode.commands.registerCommand(CMD.copyRef, async (node?: GhostexTreeNode) => {
      if (node?.kind !== 'session') return;
      await vscode.env.clipboard.writeText(node.session.sessionId);
      void vscode.window.showInformationMessage(`Copied ${node.session.sessionId}`);
    }),
  );

  return { refresh: () => void controller.refresh() };
}

// --- Config + helpers -------------------------------------------------------

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
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

/**
 * The production WebSocket factory: adapt the runtime's global `WebSocket` (the
 * browser/undici one structurally satisfies {@link WebSocketLike}) to the
 * stream's injected-socket shape. Returns `null` when the runtime has no
 * `WebSocket` (older Node without the flag) — the controller then runs
 * poll-only, so the tree still updates, just without instant deltas.
 */
function webSocketFactory(log: GhostexLogger): WebSocketFactory | null {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (typeof Ctor !== 'function') {
    log('warn', 'ghostex: no WebSocket in this runtime — session updates will poll instead of streaming');
    return null;
  }
  return (url: string) => new Ctor(url);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
