/**
 * Thin `vscode` glue for the Ghostex view: a placeholder tree that reports the
 * current gxserver discovery state, plus the command wiring under
 * `gascityCockpit.ghostex.*`. Intentionally minimal and **not** unit-tested
 * (the foundation's testable logic lives in the `vscode`-free `../ghostex`
 * cores); this layer just maps those cores onto editor surfaces.
 *
 * The real session/board trees land on top of this in later beads. For now the
 * tree shows a single status row reflecting `discoverGhostex` so an operator can
 * see at a glance whether the daemon is reachable, and "Check Connection" /
 * "Open Logs" commands make the state actionable.
 */
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  discoverGhostex,
  readiness,
  type GhostexDiscovery,
  type GhostexDiscoveryInputs,
} from '../ghostex/index.ts';
import { CONFIG_SECTION, type FeatureHost } from '../host/index.ts';

export const GHOSTEX_VIEW_ID = 'gascityCockpitGhostex.sessions';

const CMD = {
  refresh: 'gascityCockpit.ghostex.refresh',
  checkConnection: 'gascityCockpit.ghostex.checkConnection',
  showOutput: 'gascityCockpit.ghostex.showOutput',
} as const;

/** A single placeholder tree row. */
interface GhostexNode {
  readonly label: string;
  readonly description?: string;
  readonly icon: string;
  readonly tooltip?: string;
}

/** Expand a leading `~` in a configured path to the user's home directory. */
function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~(?=$|[/\\])/, homedir()) : p;
}

/** Build the discovery inputs from the `gascityCockpit.ghostex.*` settings. */
function discoveryInputs(): GhostexDiscoveryInputs {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const url = config.get<string>('ghostex.gxserverUrl', '').trim();
  const token = config.get<string>('ghostex.gxserverToken', '').trim();
  return {
    settingsUrl: url || null,
    settingsToken: token || null,
    readTokenFile: (path) => readFile(expandHome(path), 'utf8'),
  };
}

/**
 * The placeholder tree provider. Holds the latest discovery outcome and renders
 * one status row; `refresh()` re-probes gxserver and repaints.
 */
class GhostexTreeProvider implements vscode.TreeDataProvider<GhostexNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private discovery: GhostexDiscovery | null = null;

  constructor(private readonly host: FeatureHost) {}

  getTreeItem(node: GhostexNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    return item;
  }

  getChildren(): GhostexNode[] {
    if (!this.discovery) {
      return [{ label: 'Ghostex', description: 'not yet checked', icon: 'question' }];
    }
    if (this.discovery.state === 'connected') {
      const { endpoint, health } = this.discovery;
      return [
        {
          label: 'Connected',
          description: `gxserver ${health.version} · protocol ${health.protocolVersion}`,
          icon: 'pass-filled',
          tooltip: `${endpoint.baseUrl} (token: ${endpoint.tokenSource})`,
        },
      ];
    }
    return [
      {
        label: 'Unavailable',
        description: this.discovery.reason,
        icon: 'warning',
        tooltip: readiness(this.discovery).diagnostics.join('\n'),
      },
    ];
  }

  async refresh(): Promise<GhostexDiscovery> {
    try {
      this.discovery = await discoverGhostex(discoveryInputs());
    } catch (err) {
      this.host.log('error', 'ghostex: discovery threw', { error: String(err) });
      this.discovery = {
        state: 'unavailable',
        reason: 'unreachable',
        detail: `Ghostex discovery failed: ${String(err)}`,
        baseUrl: '',
      };
    }
    this.emitter.fire();
    return this.discovery;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Register the Ghostex placeholder view + its commands onto the host. */
export function registerGhostexView(host: FeatureHost): GhostexTreeProvider {
  const provider = new GhostexTreeProvider(host);
  const view = vscode.window.createTreeView(GHOSTEX_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  host.context.subscriptions.push(
    view,
    provider,
    vscode.commands.registerCommand(CMD.refresh, () => provider.refresh()),
    vscode.commands.registerCommand(CMD.checkConnection, async () => {
      const result = await provider.refresh();
      if (result.state === 'connected') {
        void vscode.window.showInformationMessage(
          `Ghostex connected: gxserver ${result.health.version} at ${result.endpoint.baseUrl}.`,
        );
      } else {
        void vscode.window.showWarningMessage(result.detail);
      }
    }),
    vscode.commands.registerCommand(CMD.showOutput, () => host.showOutput()),
  );

  return provider;
}
