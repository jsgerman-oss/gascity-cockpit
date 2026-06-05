/**
 * VS Code glue for the in-editor merge-queue review (cockpit-21l.2).
 *
 * Intentionally thin (PRD Testing Decisions: the editor-bound layer is excluded
 * from heavy unit testing). The queue derivation, ordering and formatting live
 * in the tested, `vscode`-free `../mergeQueue` core; the diff plumbing reuses the
 * read-only git helpers from `../code`. This file only:
 *
 *   - renders the derived queue as a tree, grouped by lifecycle state;
 *   - serves each entry's diff through a `TextDocumentContentProvider`, so the
 *     review document is inherently read-only — an agent worktree is never edited
 *     (the only git commands issued are read-only `git diff`);
 *   - opens the PR (the merge control) for rigs that record one.
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { BeadsApiError, type BeadsRepository } from "../beads/index.ts";
import { committedRange, unifiedDiffArgs, workingRange, type WorktreeRef } from "../code/index.ts";
import {
  branchLine,
  buildQueueTree,
  deriveMergeQueue,
  entryDescription,
  entryLabel,
  entryTooltip,
  loadErrorNode,
  prRef,
  stateIcon,
  type MergeEntryNode,
  type MergeQueueEntry,
  type MergeQueueNode,
} from "../mergeQueue/index.ts";

const execFileAsync = promisify(execFile);

const VIEW_ID = "gascityCockpit.mergeQueue";
const SCHEME = "gascity-merge-review";
/** Cap git output so a runaway diff cannot exhaust memory (20 MiB). */
const GIT_MAX_BUFFER = 20 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const STATE_SHOW_MERGED = "mergeQueue.showMerged";

const CMD = {
  refresh: "gascityCockpit.mergeQueue.refresh",
  toggleMerged: "gascityCockpit.mergeQueue.toggleMerged",
  review: "gascityCockpit.mergeQueue.reviewChanges",
  openPr: "gascityCockpit.mergeQueue.openPr",
  approveMerge: "gascityCockpit.mergeQueue.approveMerge",
  copyBranch: "gascityCockpit.mergeQueue.copyBranch",
} as const;

export interface MergeQueueDeps {
  repository: BeadsRepository;
}

export interface MergeQueueController {
  /** Reload the queue from the supervisor. */
  refresh(): void;
}

// --- Tree provider ----------------------------------------------------------

class MergeQueueProvider implements vscode.TreeDataProvider<MergeQueueNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private roots: MergeQueueNode[] = [
    { kind: "message", id: "loading", label: "Connecting to supervisor…", icon: "loading~spin" },
  ];

  constructor(
    private readonly repository: BeadsRepository,
    private showMerged: boolean,
  ) {}

  getTreeItem(node: MergeQueueNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  getChildren(node?: MergeQueueNode): MergeQueueNode[] {
    if (!node) return this.roots;
    if (node.kind === "group") return node.children;
    return [];
  }

  get includeMerged(): boolean {
    return this.showMerged;
  }

  setShowMerged(value: boolean): void {
    this.showMerged = value;
  }

  async refresh(): Promise<void> {
    try {
      // Recently-merged beads are closed, so they only appear when we ask for
      // closed beads — that is exactly what the "show merged" toggle controls.
      const data = await this.repository.loadExplorer({ includeClosed: this.showMerged });
      const records = data.cities.flatMap((c) => c.records);
      this.roots = buildQueueTree(deriveMergeQueue(records));
    } catch (err) {
      const detail = err instanceof BeadsApiError ? err.message : String(err);
      this.roots = [loadErrorNode(detail)];
    }
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function toTreeItem(node: MergeQueueNode): vscode.TreeItem {
  if (node.kind === "group") {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = node.id;
    item.description = String(node.count);
    item.iconPath = new vscode.ThemeIcon(stateIcon(node.state));
    item.contextValue = "mergeGroup";
    return item;
  }
  if (node.kind === "message") {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    if (node.detail) item.description = node.detail;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    return item;
  }

  const { entry } = node;
  const item = new vscode.TreeItem(entryLabel(entry), vscode.TreeItemCollapsibleState.None);
  item.id = node.id;
  item.description = entryDescription(entry);
  item.tooltip = new vscode.MarkdownString(entryTooltip(entry));
  item.iconPath = new vscode.ThemeIcon(stateIcon(entry.state));
  // `mergeEntry.pr` enables the Open-PR action; both match the `^mergeEntry` menus.
  item.contextValue = entry.prUrl ? "mergeEntry.pr" : "mergeEntry";
  // Default click reviews the changes — this is a review surface.
  item.command = { command: CMD.review, title: "Review Changes", arguments: [node] };
  return item;
}

// --- Read-only diff document ------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function runGit(workDir: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: workDir,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr || e.message || "git failed" };
  }
}

/**
 * Serves the unified diff for a queued entry, preferring the committed PR range
 * (`target...HEAD`, the same set a pull request shows) and falling back to the
 * working tree when the target ref is not resolvable in the worktree.
 */
class MergeDiffProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const workDir = params.get("workDir") ?? "";
    const target = params.get("target") || "main";
    const branch = params.get("branch") ?? undefined;
    const beadId = params.get("beadId") ?? "";
    if (!workDir) return "# No worktree path recorded for this bead.\n";

    const ref: WorktreeRef = branch ? { workDir, target, branch } : { workDir, target };
    const range = committedRange(ref);
    const header = headerLines(beadId, ref);

    const primary = await runGit(workDir, unifiedDiffArgs(range));
    if (primary.ok) return `${header}${primary.stdout || "# No changes on this branch relative to its target.\n"}`;
    const fallback = await runGit(workDir, unifiedDiffArgs(workingRange()));
    if (fallback.ok) return `${header}${fallback.stdout || "# No uncommitted changes in the worktree.\n"}`;
    return `${header}# Unable to compute diff in ${workDir}\n# ${primary.stderr.trim()}\n`;
  }
}

function headerLines(beadId: string, ref: WorktreeRef): string {
  return [
    `# Merge review${beadId ? ` for ${beadId}` : ""}`,
    `# ${ref.workDir}`,
    `# range: ${committedRange(ref)}${ref.branch ? ` (branch ${ref.branch})` : ""}`,
    "# (read-only — agent worktrees are never edited from the Cockpit)",
    "",
  ].join("\n");
}

async function openDiff(entry: MergeQueueEntry): Promise<void> {
  const query = new URLSearchParams({ beadId: entry.beadId, workDir: entry.workDir ?? "", target: entry.target });
  if (entry.branch) query.set("branch", entry.branch);
  const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${entry.beadId}.diff`, query: query.toString() });
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, "diff");
  await vscode.window.showTextDocument(doc, { preview: true });
}

// --- Command handlers -------------------------------------------------------

function asEntryNode(node: unknown): MergeEntryNode | null {
  if (node && typeof node === "object" && (node as MergeQueueNode).kind === "entry") {
    return node as MergeEntryNode;
  }
  return null;
}

async function openPrUrl(entry: MergeQueueEntry): Promise<void> {
  if (!entry.prUrl) {
    void vscode.window.showInformationMessage(`${entry.beadId} has no PR recorded.`);
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(entry.prUrl));
}

async function reviewChanges(node: unknown): Promise<void> {
  const entryNode = asEntryNode(node);
  if (!entryNode) {
    void vscode.window.showInformationMessage("Pick a merge-queue entry to review.");
    return;
  }
  const { entry } = entryNode;

  if (!entry.workDir) {
    if (entry.prUrl) {
      await openPrUrl(entry);
    } else {
      void vscode.window.showInformationMessage(
        `${entry.beadId}: no worktree recorded — the polecat may have finished and cleaned up.`,
      );
    }
    return;
  }

  if (!(await pathExists(entry.workDir))) {
    if (entry.prUrl) {
      const open = await vscode.window.showWarningMessage(
        `The worktree for ${entry.beadId} is gone. Open the PR instead?`,
        "Open PR",
      );
      if (open) await openPrUrl(entry);
    } else {
      void vscode.window.showWarningMessage(
        `Recorded worktree for ${entry.beadId} is gone (the polecat likely finished and cleaned up):\n${entry.workDir}`,
      );
    }
    return;
  }

  await openDiff(entry);
}

async function approveMerge(node: unknown): Promise<void> {
  const entryNode = asEntryNode(node);
  if (!entryNode) return;
  const { entry } = entryNode;

  if (entry.state === "merged") {
    void vscode.window.showInformationMessage(`${entry.beadId} is already merged.`);
    return;
  }

  if (entry.prUrl) {
    const choice = await vscode.window.showInformationMessage(
      `Open the PR for ${entry.beadId} to approve & merge?`,
      { modal: true, detail: `${prRef(entry.prUrl)} · ${branchLine(entry)}\n\nThe merge is completed on the pull-request page.` },
      "Open PR",
    );
    if (choice === "Open PR") await openPrUrl(entry);
    return;
  }

  void vscode.window.showInformationMessage(
    `${entry.beadId} has no PR — this rig's refinery merges ${branchLine(entry)} locally after handoff. ` +
      "Use “Review changes” to inspect the diff.",
  );
}

async function copyBranch(node: unknown): Promise<void> {
  const entryNode = asEntryNode(node);
  if (!entryNode?.entry.branch) {
    void vscode.window.showInformationMessage("No branch recorded for this entry.");
    return;
  }
  await vscode.env.clipboard.writeText(entryNode.entry.branch);
  void vscode.window.showInformationMessage(`Copied ${entryNode.entry.branch}`);
}

// --- Registration -----------------------------------------------------------

export function registerMergeQueue(
  context: vscode.ExtensionContext,
  deps: MergeQueueDeps,
): MergeQueueController {
  const showMerged = context.globalState.get<boolean>(STATE_SHOW_MERGED, false);
  const provider = new MergeQueueProvider(deps.repository, showMerged);
  const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });

  context.subscriptions.push(
    treeView,
    provider,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new MergeDiffProvider()),
    vscode.commands.registerCommand(CMD.refresh, () => void provider.refresh()),
    vscode.commands.registerCommand(CMD.toggleMerged, async () => {
      const next = !provider.includeMerged;
      provider.setShowMerged(next);
      await context.globalState.update(STATE_SHOW_MERGED, next);
      void vscode.window.showInformationMessage(`Merge queue: recently-merged ${next ? "shown" : "hidden"}.`);
      await provider.refresh();
    }),
    vscode.commands.registerCommand(CMD.review, (node?: unknown) => void reviewChanges(node)),
    vscode.commands.registerCommand(CMD.openPr, (node?: unknown) => {
      const entryNode = asEntryNode(node);
      if (entryNode) void openPrUrl(entryNode.entry);
    }),
    vscode.commands.registerCommand(CMD.approveMerge, (node?: unknown) => void approveMerge(node)),
    vscode.commands.registerCommand(CMD.copyBranch, (node?: unknown) => void copyBranch(node)),
  );

  void provider.refresh();
  return { refresh: () => void provider.refresh() };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
