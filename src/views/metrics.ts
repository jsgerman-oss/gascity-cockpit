// VS Code adapter for the "Metrics over time" pane (cockpit-3x7).
//
// Intentionally thin (PRD: VS Code-API-bound glue is small and excluded from
// heavy unit testing). It maps the `vscode`-free MetricsStore onto one
// TreeDataProvider — an "Overall" group plus per-rig or per-agent groups, each
// expanding to throughput / cycle-time / reject-rate rows — and renders the
// loading / empty / error edges through the shared cross-pane vocabulary
// (`src/ui/view-state.ts`, the consistent-edges contract). All number/label
// logic lives in the tested `src/metrics/format.ts`.
import * as vscode from 'vscode';
import type { Disposable } from '../discovery/index.ts';
import {
  WINDOWS,
  accessibleGroup,
  cycleDescription,
  groupDescription,
  overallSummary,
  rejectDescription,
  throughputDescription,
  type GroupMetrics,
  type MetricsState,
  type MetricsStore,
} from '../metrics/index.ts';
import {
  emptyNotice,
  errorNotice,
  loadingNotice,
  type StateNotice,
} from '../ui/view-state.ts';

const METRICS_VIEW = 'gascityCockpit.metrics';
const REFRESH_COMMAND = 'gascityCockpit.metrics.refresh';
const WINDOW_COMMAND = 'gascityCockpit.metrics.selectWindow';
const GROUP_COMMAND = 'gascityCockpit.metrics.toggleGroupBy';

type GroupDimension = 'overall' | 'rig' | 'agent';

interface MetricRow {
  label: string;
  description: string;
  icon: string;
}

type MetricsNode =
  | { kind: 'notice'; id: string; notice: StateNotice }
  | { kind: 'group'; dimension: GroupDimension; group: GroupMetrics }
  | { kind: 'metric'; parentId: string; row: MetricRow };

/** Callback the feature supplies to re-fetch + re-derive the current window. */
export type ReloadMetrics = () => void | Promise<void>;

function dimensionIcon(dimension: GroupDimension): vscode.ThemeIcon {
  switch (dimension) {
    case 'overall':
      return new vscode.ThemeIcon('dashboard');
    case 'rig':
      return new vscode.ThemeIcon('server-environment');
    case 'agent':
    default:
      return new vscode.ThemeIcon('person');
  }
}

function metricRows(group: GroupMetrics, bucketUnit: string): MetricRow[] {
  return [
    { label: 'Throughput', description: throughputDescription(group.throughput, bucketUnit), icon: 'pulse' },
    { label: 'Cycle time', description: cycleDescription(group.cycle), icon: 'watch' },
    { label: 'Reject rate', description: rejectDescription(group.reject), icon: 'issue-reopened' },
  ];
}

/** The metrics tree: notices, an Overall group, then per-rig / per-agent groups. */
export class MetricsTreeProvider implements vscode.TreeDataProvider<MetricsNode>, Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly storeSub: Disposable;

  constructor(private readonly store: MetricsStore) {
    this.storeSub = store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  dispose(): void {
    this.storeSub.dispose();
    this._onDidChangeTreeData.dispose();
  }

  getChildren(node?: MetricsNode): MetricsNode[] {
    const state = this.store.state;
    if (!node) return this.roots(state);
    if (node.kind === 'group') {
      const bucketUnit = state.model?.window.bucketUnit ?? '';
      const parentId = `${node.dimension}:${node.group.id}`;
      return metricRows(node.group, bucketUnit).map((row) => ({ kind: 'metric', parentId, row }));
    }
    return [];
  }

  private roots(state: MetricsState): MetricsNode[] {
    if (state.phase === 'idle' || state.phase === 'loading') {
      return [{ kind: 'notice', id: 'loading', notice: loadingNotice() }];
    }
    if (state.phase === 'error' || !state.model) {
      return [{ kind: 'notice', id: 'error', notice: errorNotice('metrics', state.errorDetail ?? undefined) }];
    }

    const { model, groupBy } = state;
    const quiet = model.overall.throughput.total === 0 && model.overall.reject.rejects === 0;
    if (quiet) {
      return [
        {
          kind: 'notice',
          id: 'empty',
          notice: emptyNotice('No issues closed in this window', 'Try a longer window from the title bar.'),
        },
      ];
    }

    const nodes: MetricsNode[] = [];
    if (state.partial) {
      nodes.push({
        kind: 'notice',
        id: 'partial',
        notice: emptyNotice(
          'Showing a partial window',
          'Older events beyond the fetch cap are omitted — totals are a floor.',
          'warning',
        ),
      });
    }
    nodes.push({ kind: 'group', dimension: 'overall', group: model.overall });
    const groups = groupBy === 'rig' ? model.byRig : model.byAgent;
    for (const group of groups) nodes.push({ kind: 'group', dimension: groupBy, group });
    if (groups.length === 0) {
      nodes.push({ kind: 'notice', id: 'no-groups', notice: emptyNotice(`No ${groupBy}s with activity`) });
    }
    return nodes;
  }

  getTreeItem(node: MetricsNode): vscode.TreeItem {
    const { Collapsed, None } = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case 'group': {
        const item = new vscode.TreeItem(node.group.label, Collapsed);
        item.id = `group:${node.dimension}:${node.group.id}`;
        item.description = groupDescription(node.group);
        item.iconPath = dimensionIcon(node.dimension);
        item.contextValue = `gascityMetricsGroup.${node.dimension}`;
        item.accessibilityInformation = { label: accessibleGroup(node.group) };
        return item;
      }
      case 'metric': {
        const item = new vscode.TreeItem(node.row.label, None);
        item.id = `metric:${node.parentId}:${node.row.label}`;
        item.description = node.row.description;
        item.iconPath = new vscode.ThemeIcon(node.row.icon);
        item.contextValue = 'gascityMetricsMetric';
        item.accessibilityInformation = { label: `${node.row.label}: ${node.row.description}` };
        return item;
      }
      case 'notice':
      default: {
        const item = new vscode.TreeItem(node.notice.label, None);
        item.id = `notice:${node.id}`;
        if (node.notice.detail) item.description = node.notice.detail;
        item.iconPath = new vscode.ThemeIcon(
          node.notice.icon,
          node.notice.iconColor ? new vscode.ThemeColor(node.notice.iconColor) : undefined,
        );
        item.contextValue = 'gascityMetricsNotice';
        item.accessibilityInformation = {
          label: node.notice.detail ? `${node.notice.label}, ${node.notice.detail}` : node.notice.label,
        };
        return item;
      }
    }
  }
}

/**
 * Register the metrics tree view and its title commands (refresh, select window,
 * toggle group-by), wiring the view title/description to the store. `reload`
 * re-fetches for the current window; toggling the group-by only re-renders from
 * the already-derived model (it holds both per-rig and per-agent breakdowns).
 */
export function registerMetricsViews(
  context: vscode.ExtensionContext,
  store: MetricsStore,
  reload: ReloadMetrics,
): void {
  const provider = new MetricsTreeProvider(store);
  const view = vscode.window.createTreeView(METRICS_VIEW, { treeDataProvider: provider });

  const syncTitle = (): void => {
    const state = store.state;
    view.description = state.model ? overallSummary(state.model) : undefined;
    view.message =
      state.phase === 'loading'
        ? 'Loading metrics…'
        : state.partial
          ? 'Partial window — totals are a floor.'
          : undefined;
  };
  syncTitle();

  const selectWindow = async (): Promise<void> => {
    const picked = await vscode.window.showQuickPick(
      WINDOWS.map((w) => ({ label: w.label, id: w.id })),
      { placeHolder: 'Metrics window' },
    );
    if (picked && store.setWindow(picked.id)) await reload();
  };

  context.subscriptions.push(
    provider,
    view,
    store.onDidChange(() => syncTitle()),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => reload()),
    vscode.commands.registerCommand(WINDOW_COMMAND, () => selectWindow()),
    vscode.commands.registerCommand(GROUP_COMMAND, () => store.toggleGroupBy()),
  );
}
