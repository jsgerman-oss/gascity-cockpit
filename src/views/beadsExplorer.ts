/**
 * VS Code glue for the Beads explorer (PRD stories 7–11).
 *
 * Intentionally thin (PRD Testing Decisions: the editor-bound layer is small and
 * excluded from heavy unit testing). All the real behaviour — fetching, filter,
 * group, tree shape, detail/graph rendering — lives in the tested `../beads`
 * core; this file maps that core onto a TreeDataProvider, a read-only Markdown
 * detail document, a dependency-graph webview, and the explorer commands.
 */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  accessibleBeadNodeLabel,
  BeadsApiError,
  BeadsRepository,
  beadRig,
  beadType,
  buildBeadTree,
  buildDependencyGraph,
  deriveDisplayStatus,
  displayStatusLabel,
  DEFAULT_FILTERS,
  formatBeadDetailMarkdown,
  GROUP_KEYS,
  priorityLabel,
  renderGraphSvg,
  renderGraphWebviewHtml,
  type BeadFilters,
  type BeadLeaf,
  type BeadRecord,
  type BeadTreeNode,
  type BeadViewSpec,
  type DisplayStatus,
  type ExplorerData,
  type GroupKey,
  type GroupNode,
  type MessageNode,
} from "../beads/index.ts";
import { errorNotice, loadingNotice, type StateNotice } from "../ui/index.ts";

const VIEW_ID = "gascityCockpit.beads";
const BEAD_SCHEME = "gascity-bead";
const STATE_GROUP_BY = "beads.groupBy";
const STATE_INCLUDE_CLOSED = "beads.includeClosed";
const STATE_HIDE_OPERATIONAL = "beads.hideOperational";

const CMD = {
  refresh: "gascityCockpit.beads.refresh",
  setGroupBy: "gascityCockpit.beads.setGroupBy",
  toggleClosed: "gascityCockpit.beads.toggleClosed",
  toggleOperational: "gascityCockpit.beads.toggleOperational",
  filter: "gascityCockpit.beads.filter",
  clearFilters: "gascityCockpit.beads.clearFilters",
  openDetail: "gascityCockpit.beads.openDetail",
  showGraph: "gascityCockpit.beads.showGraph",
  copyId: "gascityCockpit.beads.copyId",
} as const;

export interface BeadsExplorerDeps {
  repository: BeadsRepository;
}

export interface BeadsExplorerController {
  /** Reload from the API (call when the supervisor connects / restarts). */
  refresh(): void;
}

// --- Tree data provider -----------------------------------------------------

class BeadsTreeDataProvider implements vscode.TreeDataProvider<BeadTreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private roots: BeadTreeNode[] = [noticeNode("loading", loadingNotice())];
  private data: ExplorerData | null = null;
  private lastError: string | null = null;
  private spec: BeadViewSpec;
  private includeClosed: boolean;
  private hideOperational: boolean;

  constructor(
    private readonly repository: BeadsRepository,
    initial: { groupBy: GroupKey; includeClosed: boolean; hideOperational: boolean },
  ) {
    this.includeClosed = initial.includeClosed;
    this.hideOperational = initial.hideOperational;
    this.spec = {
      groupBy: initial.groupBy,
      filters: {
        ...DEFAULT_FILTERS,
        includeClosed: initial.includeClosed,
        hideOperational: initial.hideOperational,
      },
    };
  }

  getTreeItem(node: BeadTreeNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  getChildren(node?: BeadTreeNode): BeadTreeNode[] {
    if (!node) return this.roots;
    if (node.kind === "city" || node.kind === "group") return node.children;
    return [];
  }

  get groupBy(): GroupKey {
    return this.spec.groupBy;
  }

  get filters(): BeadFilters {
    return this.spec.filters;
  }

  /** Every loaded record across all cities (for building filter pick lists). */
  get records(): BeadRecord[] {
    return this.data?.cities.flatMap((c) => c.records) ?? [];
  }

  get filtersActive(): boolean {
    const f = this.spec.filters;
    return Boolean(f.text || f.status?.length || f.rig !== undefined || f.assignee !== undefined || f.type !== undefined || f.priority !== undefined);
  }

  setGroupBy(groupBy: GroupKey): void {
    this.spec = { ...this.spec, groupBy };
    this.rebuild();
  }

  setFilters(filters: BeadFilters): void {
    this.spec = {
      ...this.spec,
      filters: { ...filters, includeClosed: this.includeClosed, hideOperational: this.hideOperational },
    };
    this.rebuild();
  }

  async setIncludeClosed(value: boolean): Promise<void> {
    this.includeClosed = value;
    this.spec = { ...this.spec, filters: { ...this.spec.filters, includeClosed: value } };
    await this.refresh();
  }

  // Operational filtering is purely client-side, so just rebuild — no refetch.
  setHideOperational(value: boolean): void {
    this.hideOperational = value;
    this.spec = { ...this.spec, filters: { ...this.spec.filters, hideOperational: value } };
    this.rebuild();
  }

  async refresh(): Promise<void> {
    try {
      this.data = await this.repository.loadExplorer({ includeClosed: this.includeClosed });
      this.lastError = null;
    } catch (err) {
      this.data = null;
      this.lastError = err instanceof BeadsApiError ? err.message : String(err);
    }
    this.rebuild();
  }

  private rebuild(): void {
    if (this.lastError) {
      this.roots = [noticeNode("error", errorNotice("beads", this.lastError))];
    } else if (this.data) {
      this.roots = buildBeadTree(this.data, this.spec);
    }
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function toTreeItem(node: BeadTreeNode): vscode.TreeItem {
  const item = buildTreeItem(node);
  // Fold the icon-conveyed status into the accessible name so screen-reader
  // users hear what sighted users see in the status icon (a11y, Phase 3).
  item.accessibilityInformation = { label: accessibleBeadNodeLabel(node) };
  return item;
}

function buildTreeItem(node: BeadTreeNode): vscode.TreeItem {
  switch (node.kind) {
    case "city": {
      const item = new vscode.TreeItem(node.city, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.contextValue = "gascityCity";
      item.iconPath = new vscode.ThemeIcon(node.running ? "server-environment" : "circle-slash");
      item.description = node.error ? "error" : node.running ? `${node.count}${node.partial ? "+" : ""}` : "stopped";
      item.tooltip = node.error ?? `${node.city} — ${node.count} bead(s)${node.partial ? " (truncated)" : ""}`;
      return item;
    }
    case "group": {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.contextValue = "gascityGroup";
      item.description = `${node.count}`;
      item.iconPath = groupIcon(node);
      return item;
    }
    case "bead": {
      const bead = node.record.bead;
      const item = new vscode.TreeItem(bead.id, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.contextValue = "gascityBead";
      item.description = bead.title ?? "";
      item.iconPath = statusIcon(node.displayStatus);
      item.tooltip = beadTooltip(node);
      item.command = { command: CMD.openDetail, title: "Open Bead", arguments: [node] };
      return item;
    }
    case "message": {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.contextValue = "gascityMessage";
      if (node.icon) {
        item.iconPath = node.iconColor
          ? new vscode.ThemeIcon(node.icon, new vscode.ThemeColor(node.iconColor))
          : new vscode.ThemeIcon(node.icon);
      }
      item.description = node.detail;
      item.tooltip = node.detail;
      return item;
    }
  }
}

const STATUS_ICONS: Record<string, [string, string?]> = {
  in_progress: ["play-circle", "charts.blue"],
  ready: ["circle-large-outline", "charts.green"],
  blocked: ["error", "charts.red"],
  open: ["circle-outline"],
  deferred: ["clock", "charts.yellow"],
  escalated: ["warning", "charts.orange"],
  closed: ["pass-filled", "disabledForeground"],
};

function statusIcon(status: DisplayStatus): vscode.ThemeIcon {
  const [icon, color] = STATUS_ICONS[status] ?? ["circle-outline"];
  return color ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(color)) : new vscode.ThemeIcon(icon);
}

const GROUP_ICONS: Record<GroupKey, string> = {
  status: "pulse",
  rig: "server",
  assignee: "account",
  type: "symbol-class",
  priority: "arrow-up",
};

function groupIcon(node: GroupNode): vscode.ThemeIcon {
  if (node.groupBy === "status") return statusIcon(node.key);
  return new vscode.ThemeIcon(GROUP_ICONS[node.groupBy] ?? "folder");
}

function beadTooltip(node: BeadLeaf): vscode.MarkdownString {
  const bead = node.record.bead;
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${escapeMd(bead.id)}** — ${escapeMd(bead.title ?? "")}\n\n`);
  md.appendMarkdown(`${displayStatusLabel(node.displayStatus)} · ${priorityLabel(bead.priority)}\n\n`);
  md.appendMarkdown(`Type: \`${beadType(bead)}\` · Rig: \`${beadRig(bead)}\``);
  if (bead.assignee) md.appendMarkdown(` · Assignee: \`${bead.assignee}\``);
  return md;
}

function noticeNode(suffix: string, notice: StateNotice): MessageNode {
  return {
    kind: "message",
    id: `msg:${suffix}`,
    label: notice.label,
    detail: notice.detail,
    icon: notice.icon,
    iconColor: notice.iconColor,
  };
}

// --- Bead detail (read-only Markdown virtual document) ----------------------

class BeadDetailContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly repository: BeadsRepository) {}

  refresh(uri: vscode.Uri): void {
    this.emitter.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const city = params.get("city") ?? "";
    const id = params.get("id") ?? "";
    const ready = params.get("ready");
    try {
      const bead = await this.repository.getBead(city, id);
      const record: BeadRecord = { city, bead, ready: ready === "1" ? true : ready === "0" ? false : null };
      return formatBeadDetailMarkdown(record);
    } catch (err) {
      const detail = err instanceof BeadsApiError ? err.message : String(err);
      return `# ${id}\n\n> Failed to load bead from \`${city}\`:\n>\n> ${detail}\n`;
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function detailUri(city: string, id: string, ready: boolean | null): vscode.Uri {
  const query = new URLSearchParams({ city, id, ready: ready === true ? "1" : ready === false ? "0" : "" });
  return vscode.Uri.from({ scheme: BEAD_SCHEME, path: `/${id}.md`, query: query.toString() });
}

// --- Dependency-graph webview -----------------------------------------------

class BeadGraphView {
  private panel: vscode.WebviewPanel | null = null;
  private currentCity = "";

  constructor(
    private readonly repository: BeadsRepository,
    private readonly onOpenBead: (city: string, id: string) => void,
  ) {}

  async show(city: string, rootId: string): Promise<void> {
    this.currentCity = city;
    const title = `Deps: ${rootId}`;
    let body: string;
    try {
      const resp = await this.repository.getBeadGraph(city, rootId);
      body = `<div class="gc-wrap">${renderGraphSvg(buildDependencyGraph(resp))}</div>`;
    } catch (err) {
      const detail = err instanceof BeadsApiError ? err.message : String(err);
      body = `<p class="gc-error">Failed to load dependency graph for ${escapeHtml(rootId)}: ${escapeHtml(detail)}</p>`;
    }

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "gascityBeadGraph",
        title,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = null;
      });
      this.panel.webview.onDidReceiveMessage((msg: { type?: string; id?: string }) => {
        if (msg?.type === "open" && typeof msg.id === "string") this.onOpenBead(this.currentCity, msg.id);
      });
    }
    this.panel.title = title;
    this.panel.webview.html = this.html(this.panel.webview, body);
    this.panel.reveal();
  }

  private html(webview: vscode.Webview, body: string): string {
    const nonce = randomBytes(16).toString("base64");
    return renderGraphWebviewHtml({ body, nonce, cspSource: webview.cspSource });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }
}

// --- Registration + commands ------------------------------------------------

export function registerBeadsExplorer(
  context: vscode.ExtensionContext,
  deps: BeadsExplorerDeps,
): BeadsExplorerController {
  const storedGroupBy = context.globalState.get<GroupKey>(STATE_GROUP_BY, "status");
  const groupBy = GROUP_KEYS.includes(storedGroupBy) ? storedGroupBy : "status";
  const includeClosed = context.globalState.get<boolean>(STATE_INCLUDE_CLOSED, false);
  const hideOperational = context.globalState.get<boolean>(STATE_HIDE_OPERATIONAL, true);

  const provider = new BeadsTreeDataProvider(deps.repository, { groupBy, includeClosed, hideOperational });
  const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });
  const detailProvider = new BeadDetailContentProvider(deps.repository);
  const openDetail = (city: string, id: string, ready: boolean | null): void => {
    const uri = detailUri(city, id, ready);
    detailProvider.refresh(uri);
    void Promise.resolve(vscode.commands.executeCommand("markdown.showPreview", uri)).then(undefined, async () => {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    });
  };
  const graphView = new BeadGraphView(deps.repository, (city, id) => openDetail(city, id, null));

  const syncMeta = (): void => {
    treeView.description = `by ${provider.groupBy}${provider.filtersActive ? " · filtered" : ""}`;
  };
  syncMeta();

  context.subscriptions.push(
    treeView,
    provider,
    detailProvider,
    vscode.workspace.registerTextDocumentContentProvider(BEAD_SCHEME, detailProvider),
    vscode.commands.registerCommand(CMD.refresh, () => provider.refresh()),
    vscode.commands.registerCommand(CMD.setGroupBy, async () => {
      const picked = await pickGroupBy(provider.groupBy);
      if (!picked) return;
      provider.setGroupBy(picked);
      await context.globalState.update(STATE_GROUP_BY, picked);
      syncMeta();
    }),
    vscode.commands.registerCommand(CMD.toggleClosed, async () => {
      const next = !provider.filters.includeClosed;
      await provider.setIncludeClosed(next);
      await context.globalState.update(STATE_INCLUDE_CLOSED, next);
      void vscode.window.showInformationMessage(`Closed beads ${next ? "shown" : "hidden"}.`);
    }),
    vscode.commands.registerCommand(CMD.toggleOperational, async () => {
      const next = !provider.filters.hideOperational;
      provider.setHideOperational(next);
      await context.globalState.update(STATE_HIDE_OPERATIONAL, next);
      void vscode.window.showInformationMessage(`Operational wisps ${next ? "hidden" : "shown"}.`);
    }),
    vscode.commands.registerCommand(CMD.filter, async () => {
      await runFilterPicker(provider);
      syncMeta();
    }),
    vscode.commands.registerCommand(CMD.clearFilters, () => {
      provider.setFilters({ includeClosed: provider.filters.includeClosed });
      syncMeta();
    }),
    vscode.commands.registerCommand(CMD.openDetail, (node?: BeadTreeNode) => {
      const leaf = asBeadLeaf(node);
      if (leaf) openDetail(leaf.city, leaf.beadId, leaf.record.ready);
    }),
    vscode.commands.registerCommand(CMD.showGraph, (node?: BeadTreeNode) => {
      const leaf = asBeadLeaf(node);
      if (leaf) void graphView.show(leaf.city, leaf.beadId);
    }),
    vscode.commands.registerCommand(CMD.copyId, async (node?: BeadTreeNode) => {
      const leaf = asBeadLeaf(node);
      if (!leaf) return;
      await vscode.env.clipboard.writeText(leaf.beadId);
      void vscode.window.showInformationMessage(`Copied ${leaf.beadId}`);
    }),
    { dispose: () => graphView.dispose() },
  );

  // The extension drives the first (and every reconnect) refresh once the
  // supervisor connection reports an endpoint — see `activate`.
  return { refresh: () => void provider.refresh() };
}

function asBeadLeaf(node?: BeadTreeNode): BeadLeaf | null {
  return node && node.kind === "bead" ? node : null;
}

async function pickGroupBy(current: GroupKey): Promise<GroupKey | undefined> {
  const items = GROUP_KEYS.map((key) => ({
    label: key,
    description: key === current ? "current" : undefined,
    key,
  }));
  const picked = await vscode.window.showQuickPick(items, { title: "Group beads by", placeHolder: "Choose a grouping" });
  return picked?.key;
}

async function runFilterPicker(provider: BeadsTreeDataProvider): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "$(search) Text search…", id: "text" },
      { label: "$(pulse) Status…", id: "status" },
      { label: "$(server) Rig…", id: "rig" },
      { label: "$(account) Assignee…", id: "assignee" },
      { label: "$(symbol-class) Type…", id: "type" },
      { label: "$(arrow-up) Priority…", id: "priority" },
      { label: "$(clear-all) Clear all filters", id: "clear" },
    ],
    { title: "Filter beads", placeHolder: "Choose a filter dimension" },
  );
  if (!choice) return;

  const filters: BeadFilters = { ...provider.filters };
  const records = provider.records;

  switch (choice.id) {
    case "clear":
      provider.setFilters({ includeClosed: filters.includeClosed });
      return;
    case "text": {
      const value = await vscode.window.showInputBox({
        title: "Text search",
        prompt: "Match bead id or title (blank to clear)",
        value: filters.text ?? "",
      });
      if (value === undefined) return;
      filters.text = value.trim() || undefined;
      break;
    }
    case "status": {
      const present = distinctStatuses(records);
      const picks = await vscode.window.showQuickPick(
        present.map((s) => ({ label: displayStatusLabel(s), value: s, picked: filters.status?.includes(s) ?? false })),
        { canPickMany: true, title: "Filter by status (none = all)" },
      );
      if (!picks) return;
      filters.status = picks.length > 0 ? picks.map((p) => p.value) : undefined;
      break;
    }
    case "rig": {
      const result = await pickSingle("Filter by rig", distinctRigs(records), filters.rig);
      if (!result.set) return;
      filters.rig = result.value;
      break;
    }
    case "assignee": {
      const result = await pickSingle(
        "Filter by assignee",
        distinctAssignees(records).map((a) => ({ value: a, label: a === "" ? "(unassigned)" : a })),
        filters.assignee,
      );
      if (!result.set) return;
      filters.assignee = result.value;
      break;
    }
    case "type": {
      const result = await pickSingle("Filter by type", distinctTypes(records), filters.type);
      if (!result.set) return;
      filters.type = result.value;
      break;
    }
    case "priority": {
      const result = await pickSingle(
        "Filter by priority",
        distinctPriorities(records).map((p) => ({ value: String(p), label: priorityLabel(p) })),
        filters.priority === undefined ? undefined : String(filters.priority),
      );
      if (!result.set) return;
      filters.priority = result.value === undefined ? undefined : Number(result.value);
      break;
    }
  }
  provider.setFilters(filters);
}

interface PickResult {
  set: boolean;
  value?: string;
}

async function pickSingle(
  title: string,
  values: string[] | Array<{ value: string; label: string }>,
  current?: string,
): Promise<PickResult> {
  const normalized = values.map((v) => (typeof v === "string" ? { value: v, label: v } : v));
  const items = [
    { label: "$(clear-all) (any)", value: undefined as string | undefined },
    ...normalized.map((v) => ({ label: v.label, value: v.value, description: v.value === current ? "current" : undefined })),
  ];
  const picked = await vscode.window.showQuickPick(items, { title });
  if (!picked) return { set: false };
  return { set: true, value: picked.value };
}

function distinctStatuses(records: BeadRecord[]): DisplayStatus[] {
  const set = new Set<DisplayStatus>();
  for (const record of records) set.add(deriveDisplayStatus(record));
  return [...set];
}

function distinctRigs(records: BeadRecord[]): string[] {
  return [...new Set(records.map((r) => beadRig(r.bead)))].sort((a, b) => a.localeCompare(b));
}

function distinctAssignees(records: BeadRecord[]): string[] {
  return [...new Set(records.map((r) => r.bead.assignee ?? ""))].sort((a, b) => a.localeCompare(b));
}

function distinctTypes(records: BeadRecord[]): string[] {
  return [...new Set(records.map((r) => r.bead.issue_type ?? ""))].sort((a, b) => a.localeCompare(b));
}

function distinctPriorities(records: BeadRecord[]): number[] {
  return [...new Set(records.map((r) => r.bead.priority).filter((p): p is number => p !== undefined))].sort(
    (a, b) => a - b,
  );
}

function escapeMd(value: string): string {
  return value.replace(/([\\`*_[\]])/g, "\\$1");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
