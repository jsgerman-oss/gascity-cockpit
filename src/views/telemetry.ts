// VS Code adapter for the cost & tier telemetry pane.
//
// Intentionally thin (PRD: VS Code-API-bound glue is kept small and excluded
// from heavy unit testing). It maps the `vscode`-free TelemetryStore onto one
// TreeDataProvider — "By Agent" and "By Bead" groups, each scope expanding to its
// per-model breakdown — and re-renders on the store's single change signal. All
// label/description/number logic lives in the tested `format.ts`.
import * as vscode from 'vscode';
import type { Disposable } from '../discovery/index.ts';
import {
  accessibleModelLabel,
  accessibleScopeLabel,
  formatCost,
  formatDurationMs,
  formatTokenBreakdown,
  modelDescription,
  modelLabel,
  modelStatusKind,
  scopeDescription,
  scopeLabel,
  scopeStatusKind,
  totalsSummary,
  type ModelRollup,
  type ScopeRollup,
  type StatusKind,
  type TelemetryState,
  type TelemetryStore,
} from '../telemetry/index.ts';

const TELEMETRY_VIEW = 'gascityCockpit.telemetry';
const CLEAR_COMMAND = 'gascityCockpit.clearTelemetry';

type ScopeGroup = 'agents' | 'beads';

type TelemetryNode =
  | { kind: 'group'; group: ScopeGroup }
  | { kind: 'scope'; group: ScopeGroup; scope: ScopeRollup }
  | { kind: 'model'; group: ScopeGroup; parentKey: string; model: ModelRollup }
  | { kind: 'notice'; id: string; label: string; description?: string; severity?: StatusKind };

function statusIcon(kind: StatusKind): vscode.ThemeIcon {
  switch (kind) {
    case 'ok':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    case 'busy':
      return new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.blue'));
    case 'idle':
      return new vscode.ThemeIcon('circle-outline');
    case 'warn':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    case 'off':
    default:
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
  }
}

/** The telemetry tree: (By Agent | By Bead) → scope → per-model rows. */
export class TelemetryTreeProvider implements vscode.TreeDataProvider<TelemetryNode>, Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly storeSub: Disposable;

  constructor(private readonly store: TelemetryStore) {
    this.storeSub = store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  dispose(): void {
    this.storeSub.dispose();
    this._onDidChangeTreeData.dispose();
  }

  getChildren(node?: TelemetryNode): TelemetryNode[] {
    const state = this.store.state;
    if (!node) return this.roots(state);
    if (node.kind === 'group') {
      const scopes = node.group === 'agents' ? state.agents : state.beads;
      if (!scopes.length) {
        const what = node.group === 'agents' ? 'agents' : 'beads';
        return [{ kind: 'notice', id: `empty:${node.group}`, label: `No ${what} yet` }];
      }
      return scopes.map((scope) => ({ kind: 'scope', group: node.group, scope }));
    }
    if (node.kind === 'scope') {
      return node.scope.models.map((model) => ({
        kind: 'model',
        group: node.group,
        parentKey: node.scope.key,
        model,
      }));
    }
    return [];
  }

  private roots(state: TelemetryState): TelemetryNode[] {
    const roots: TelemetryNode[] = [];
    if (state.totals.operations === 0) {
      roots.push({
        kind: 'notice',
        id: 'no-telemetry',
        label: 'No worker operations observed yet',
        description: 'streams from worker.operation events',
      });
      return roots;
    }
    if (!state.anyCostMeasured) {
      roots.push({
        kind: 'notice',
        id: 'awaiting-instrumentation',
        label: 'Tokens & cost not yet instrumented',
        description: 'model & op counts only — see docs',
        severity: 'warn',
      });
    }
    if (state.evicted) {
      roots.push({
        kind: 'notice',
        id: 'evicted',
        label: 'Older scopes dropped to cap memory',
        description: 'totals remain complete',
      });
    }
    roots.push({ kind: 'group', group: 'agents' });
    roots.push({ kind: 'group', group: 'beads' });
    return roots;
  }

  getTreeItem(node: TelemetryNode): vscode.TreeItem {
    const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case 'group': {
        const state = this.store.state;
        const scopes = node.group === 'agents' ? state.agents : state.beads;
        const title = node.group === 'agents' ? 'By Agent' : 'By Bead';
        const item = new vscode.TreeItem(`${title} (${scopes.length})`, Expanded);
        item.id = `group:${node.group}`;
        item.iconPath = new vscode.ThemeIcon(node.group === 'agents' ? 'organization' : 'circuit-board');
        item.contextValue = `gascityTelemetryGroup.${node.group}`;
        item.accessibilityInformation = { label: `${title}, ${scopes.length}` };
        return item;
      }
      case 'scope': {
        const { scope } = node;
        const item = new vscode.TreeItem(scopeLabel(scope), scope.models.length ? Collapsed : None);
        item.id = `scope:${node.group}:${scope.key}`;
        item.description = scopeDescription(scope);
        item.iconPath = statusIcon(scopeStatusKind(scope));
        item.contextValue = 'gascityTelemetryScope';
        item.tooltip = scopeTooltip(node.group, scope);
        item.accessibilityInformation = { label: accessibleScopeLabel(scope) };
        return item;
      }
      case 'model': {
        const { model } = node;
        const item = new vscode.TreeItem(modelLabel(model), None);
        item.id = `model:${node.group}:${node.parentKey}:${model.model}`;
        item.description = modelDescription(model);
        item.iconPath = statusIcon(modelStatusKind(model));
        item.contextValue = 'gascityTelemetryModel';
        item.tooltip = modelTooltip(model);
        item.accessibilityInformation = { label: accessibleModelLabel(model) };
        return item;
      }
      case 'notice':
      default: {
        const item = new vscode.TreeItem(node.label, None);
        item.id = `notice:${node.id}`;
        if (node.description) item.description = node.description;
        item.iconPath = statusIcon(node.severity ?? 'idle');
        item.contextValue = 'gascityTelemetryNotice';
        item.accessibilityInformation = {
          label: node.description ? `${node.label}, ${node.description}` : node.label,
        };
        return item;
      }
    }
  }
}

function scopeTooltip(group: ScopeGroup, scope: ScopeRollup): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const what = group === 'agents' ? 'Agent' : 'Bead';
  md.appendMarkdown(`**${what}: ${scope.key}**\n\n`);
  md.appendMarkdown(`- Operations: ${scope.operations} (${scope.succeeded} ok · ${scope.failed} failed)\n`);
  md.appendMarkdown(`- Duration: ${formatDurationMs(scope.durationMs)}\n`);
  md.appendMarkdown(`- Tokens: ${formatTokenBreakdown(scope.tokens)}\n`);
  md.appendMarkdown(`- Cost: ${formatCost(scope.costUsd, scope.costMeasuredOps)}\n`);
  if (scope.models.length) {
    md.appendMarkdown(`- Models: ${scope.models.map((m) => m.model).join(', ')}\n`);
  }
  return md;
}

function modelTooltip(model: ModelRollup): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Model: ${model.model}**\n\n`);
  if (model.providers.length) md.appendMarkdown(`- Provider: ${model.providers.join(', ')}\n`);
  md.appendMarkdown(`- Operations: ${model.operations} (${model.succeeded} ok · ${model.failed} failed)\n`);
  md.appendMarkdown(`- Duration: ${formatDurationMs(model.durationMs)}\n`);
  md.appendMarkdown(`- Tokens: ${formatTokenBreakdown(model.tokens)}\n`);
  md.appendMarkdown(`- Cost: ${formatCost(model.costUsd, model.costMeasuredOps)}\n`);
  return md;
}

/**
 * Register the telemetry tree view and its Clear command, wiring the view
 * title/description to the store. Disposables are pushed onto the context.
 */
export function registerTelemetryViews(
  context: vscode.ExtensionContext,
  store: TelemetryStore,
): void {
  const provider = new TelemetryTreeProvider(store);
  const view = vscode.window.createTreeView(TELEMETRY_VIEW, { treeDataProvider: provider });

  const syncTitle = (): void => {
    const { state } = store;
    view.description = state.totals.operations ? totalsSummary(state.totals) : undefined;
    const stream = state.stream;
    view.message =
      stream && (stream.state === 'reconnecting' || stream.state === 'connecting')
        ? `Telemetry stream ${stream.detail}`
        : undefined;
  };
  syncTitle();

  context.subscriptions.push(
    provider,
    view,
    store.onDidChange(() => syncTitle()),
    vscode.commands.registerCommand(CLEAR_COMMAND, () => store.clear()),
  );
}
