/**
 * VS Code glue for the live town-topology graph (cockpit-21l.5).
 *
 * Intentionally thin (PRD Testing Decisions: the editor-bound layer is small and
 * excluded from heavy unit testing). All the behaviour worth testing — the
 * hierarchy derivation, layout, colour mapping, and the webview shell — lives in
 * the `vscode`-free `../town` core; this file owns a single webview panel and
 * pushes a freshly-rendered SVG to it whenever the fleet store changes, so the
 * graph updates live as SSE events land.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  buildTownGraph,
  renderTownSummary,
  renderTownSvg,
  renderTownWebviewHtml,
  type TownStateInput,
} from '../town/index.ts';
import type { Logger } from '../discovery/index.ts';
import type { FleetStatusState } from '../status/index.ts';

const VIEW_TYPE = 'gascityCockpit.townTopology';
const PANEL_TITLE = 'Town Topology';

/** The command that opens (or reveals) the topology panel. */
export const SHOW_TOPOLOGY_COMMAND = 'gascityCockpit.townTopology.show';

/** The observable fleet model the panel renders from (a structural view of the store). */
export interface TownTopologyStore {
  readonly state: FleetStatusState;
  onDidChange(listener: (state: FleetStatusState) => void): vscode.Disposable;
}

export interface TownTopologyDeps {
  store: TownTopologyStore;
  /** Invoked when the panel opens — the feature begins streaming live data. */
  onActivate(): void;
  /** Invoked when the panel closes — the feature stops streaming. */
  onDeactivate(): void;
  log: Logger;
}

/** Project the snapshot-and-lifecycle slice of the store onto the core's input. */
function toInput(state: FleetStatusState): TownStateInput {
  return {
    health: state.health,
    cities: state.cities,
    agentsByCity: state.agentsByCity,
    sessionsByCity: state.sessionsByCity,
    loading: state.loading,
    lastError: state.lastError,
  };
}

/**
 * Singleton webview panel for the topology graph. `show` creates it or reveals
 * the existing one. While open it re-renders on every store change; on dispose
 * it tells the feature to stop streaming.
 */
class TownTopologyPanel {
  private static instance: TownTopologyPanel | undefined;

  static show(deps: TownTopologyDeps): void {
    if (TownTopologyPanel.instance) {
      TownTopologyPanel.instance.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, PANEL_TITLE, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      // The shell loads no local resources — it renders an inline SVG only.
      localResourceRoots: [],
    });
    TownTopologyPanel.instance = new TownTopologyPanel(panel, deps);
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: TownTopologyDeps,
  ) {
    panel.webview.html = renderTownWebviewHtml({
      nonce: randomBytes(16).toString('base64'),
      cspSource: panel.webview.cspSource,
    });
    panel.webview.onDidReceiveMessage(
      (msg: { type?: string }) => {
        // The shell asks for the first paint once its script is live (race-free).
        if (msg?.type === 'ready') this.render();
      },
      undefined,
      this.disposables,
    );
    this.disposables.push(this.deps.store.onDidChange(() => this.render()));
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.deps.onActivate();
  }

  private render(): void {
    const graph = buildTownGraph(toInput(this.deps.store.state));
    void this.panel.webview.postMessage({
      type: 'render',
      svg: renderTownSvg(graph),
      summary: renderTownSummary(graph),
    });
  }

  private dispose(): void {
    TownTopologyPanel.instance = undefined;
    this.deps.onDeactivate();
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

/** Register the `Show Town Topology` command. Pushes disposables onto `context`. */
export function registerTownTopology(context: vscode.ExtensionContext, deps: TownTopologyDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_TOPOLOGY_COMMAND, () => {
      deps.log('info', 'opening town topology graph');
      TownTopologyPanel.show(deps);
    }),
  );
}
