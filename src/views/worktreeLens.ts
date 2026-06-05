/**
 * VS Code glue for the worktree code lens (cockpit-21l.8): annotate a file with
 * the in-flight beads/polecats editing it right now, so an operator spots a
 * collision before it happens.
 *
 * Intentionally thin (PRD Testing Decisions: the editor-bound layer is excluded
 * from heavy unit testing). The data-shaping and formatting live in the tested,
 * `vscode`-free `../code` core (`lens.ts`); this file:
 *
 *   - polls the beads across every city, resolves each in-progress bead's
 *     worktree, and runs **read-only** `git diff --name-status` to learn which
 *     files that worktree touches (never editing an agent sandbox);
 *   - scopes to worktrees of the *same* git repository as the open workspace
 *     (shared `--git-common-dir`) so an unrelated rig's `src/index.ts` is not a
 *     false collision, and excludes the operator's own checkout;
 *   - exposes the resulting index through a CodeLens provider (a lens at the top
 *     of the file) and a FileDecoration provider (a badge in the Explorer/tabs).
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Bead, BeadsRepository } from "../beads/index.ts";
import type { Logger } from "../discovery/index.ts";
import {
  buildActivity,
  buildIndex,
  changeLabel,
  committedRange,
  nameStatusArgs,
  parseNameStatus,
  resolveWorktree,
  touchDecoration,
  touchDetail,
  touchSummary,
  workingRange,
  WorktreeActivityIndex,
  type DiffFile,
  type FileTouch,
  type WorktreeRef,
} from "../code/index.ts";

const execFileAsync = promisify(execFile);

const CONFIG_SECTION = "gascityCockpit";
const CONFIG_PREFIX = "gascityCockpit.worktreeLens";
/** Cap git output so a runaway diff cannot exhaust memory (20 MiB). */
const GIT_MAX_BUFFER = 20 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const MIN_REFRESH_SECONDS = 5;
const DEFAULT_REFRESH_SECONDS = 30;

const CMD = {
  show: "gascityCockpit.worktreeLens.show",
  refresh: "gascityCockpit.worktreeLens.refresh",
} as const;

/** The diff command this lens reuses to show another worktree read-only (owned by codeNav). */
const SHOW_DIFF_CMD = "gascityCockpit.code.showDiff";

export interface WorktreeLensDeps {
  repository: BeadsRepository;
  log: Logger;
}

/** Outcome of a read-only git invocation in a worktree. */
interface GitResult {
  ok: boolean;
  stdout: string;
}

async function runGit(workDir: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: workDir,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** Absolute shared git directory all worktrees of one repo agree on, or null. */
async function gitCommonDir(dir: string): Promise<string | null> {
  const res = await runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const out = res.stdout.trim();
  return res.ok && out ? out : null;
}

/**
 * The files a worktree currently touches: the union of its committed PR range
 * (`target...HEAD`) and its uncommitted working tree (`HEAD`). Both are read-only.
 * De-duplication and normalisation happen in the core's `buildActivity`.
 */
async function computeChangedFiles(ref: WorktreeRef): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  const committed = await runGit(ref.workDir, nameStatusArgs(committedRange(ref)));
  if (committed.ok) files.push(...parseNameStatus(committed.stdout));
  const working = await runGit(ref.workDir, nameStatusArgs(workingRange()));
  if (working.ok) files.push(...parseNameStatus(working.stdout));
  return files;
}

function isInFlight(bead: Bead): boolean {
  const status = (bead.status ?? "").toLowerCase();
  return status === "in_progress" || status === "in-progress";
}

/** Absolute fsPath of the primary workspace folder, or undefined when none is open. */
function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * The repo-relative path of a file URI, or null when it is outside the workspace
 * (then it cannot be compared against worktree-relative diff paths). `false`
 * keeps the path workspace-folder-relative; `asRelativePath` returns the input
 * unchanged when the URI lies outside every folder.
 */
function relativePathOf(uri: vscode.Uri): string | null {
  if (uri.scheme !== "file") return null;
  const rel = vscode.workspace.asRelativePath(uri, false);
  return rel === uri.fsPath ? null : rel;
}

/**
 * Owns the activity index and its refresh loop. The providers read
 * `controller.index`; the controller fires the change events that make VS Code
 * re-query them after each refresh.
 */
class WorktreeLensController {
  private current: WorktreeActivityIndex = buildIndex([]);
  private running = false;
  private pending = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private readonly lensChanged = new vscode.EventEmitter<void>();
  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();

  readonly onDidChangeLenses = this.lensChanged.event;
  readonly onDidChangeDecorations = this.decorationsChanged.event;

  constructor(private readonly deps: WorktreeLensDeps) {}

  get index(): WorktreeActivityIndex {
    return this.current;
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("worktreeLens.enabled", true);
  }

  private get intervalSeconds(): number {
    const raw = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<number>("worktreeLens.refreshIntervalSeconds", DEFAULT_REFRESH_SECONDS);
    return Math.max(MIN_REFRESH_SECONDS, raw);
  }

  /** Start the refresh loop: an immediate refresh plus a periodic timer. */
  start(): void {
    this.reschedule();
    this.trigger();
  }

  /** Coalescing entry point — safe to call from the timer, status changes, or a command. */
  trigger(): void {
    void this.refresh();
  }

  private reschedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.enabled) this.timer = setInterval(() => this.trigger(), this.intervalSeconds * 1000);
  }

  /** React to a relevant configuration change: reschedule, then refresh (or clear). */
  onConfigChange(event: vscode.ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration(CONFIG_PREFIX)) return;
    this.reschedule();
    this.trigger();
  }

  private setIndex(index: WorktreeActivityIndex): void {
    this.current = index;
    this.lensChanged.fire();
    this.decorationsChanged.fire(undefined);
  }

  private async refresh(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      await this.refreshOnce();
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        this.trigger();
      }
    }
  }

  private async refreshOnce(): Promise<void> {
    if (!this.enabled) {
      this.setIndex(buildIndex([]));
      return;
    }

    const root = workspaceRoot();
    const repoCommonDir = root ? await gitCommonDir(root) : null;

    let explorer;
    try {
      explorer = await this.deps.repository.loadExplorer();
    } catch (err) {
      // Disconnected or transient API failure: clear annotations rather than
      // leaving stale ones, and try again on the next tick.
      this.deps.log("debug", `worktree lens: bead load failed: ${String(err)}`);
      this.setIndex(buildIndex([]));
      return;
    }

    const activities = [];
    for (const city of explorer.cities) {
      for (const record of city.records) {
        if (!isInFlight(record.bead)) continue;
        const ref = resolveWorktree(record.bead);
        if (!ref) continue;
        // Same-repo scope: skip worktrees that belong to a different repository,
        // so an unrelated rig's identically-named file is not a false collision.
        // Fail open when the common dir cannot be determined for either side.
        if (repoCommonDir) {
          const cd = await gitCommonDir(ref.workDir);
          if (cd && cd !== repoCommonDir) continue;
        }
        const files = await computeChangedFiles(ref);
        if (files.length === 0) continue;
        const activity = buildActivity(record.bead, record.city, files);
        if (activity) activities.push(activity);
      }
    }

    const index = buildIndex(activities, root ? { excludeWorkDir: root } : {});
    this.setIndex(index);
    this.deps.log("info", `worktree lens: ${index.worktreeCount} worktree(s) across ${index.pathCount} file(s)`);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.lensChanged.dispose();
    this.decorationsChanged.dispose();
  }
}

class WorktreeLensCodeLensProvider implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  constructor(private readonly controller: WorktreeLensController) {
    this.onDidChangeCodeLenses = controller.onDidChangeLenses;
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const rel = relativePathOf(document.uri);
    if (!rel) return [];
    const touches = this.controller.index.touching(rel);
    if (touches.length === 0) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title: touchSummary(touches),
        tooltip: touchDetail(touches),
        command: CMD.show,
        arguments: [rel],
      }),
    ];
  }
}

class WorktreeLensDecorationProvider implements vscode.FileDecorationProvider {
  readonly onDidChangeFileDecorations: vscode.Event<undefined>;

  constructor(private readonly controller: WorktreeLensController) {
    this.onDidChangeFileDecorations = controller.onDidChangeDecorations;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const rel = relativePathOf(uri);
    if (!rel) return undefined;
    const deco = touchDecoration(this.controller.index.touching(rel));
    if (!deco) return undefined;
    const decoration = new vscode.FileDecoration(
      deco.badge,
      deco.tooltip,
      new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
    );
    decoration.propagate = false;
    return decoration;
  }
}

/** Show the worktrees editing a file and offer to open one's read-only diff. */
async function showTouches(controller: WorktreeLensController, relPath: string | undefined): Promise<void> {
  const rel = relPath ?? (vscode.window.activeTextEditor ? relativePathOf(vscode.window.activeTextEditor.document.uri) : null);
  if (!rel) return;
  const touches = controller.index.touching(rel);
  if (touches.length === 0) {
    void vscode.window.showInformationMessage(`No other worktree is editing ${rel} right now.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    touches.map((touch) => ({
      label: `$(git-branch) ${touch.beadId}`,
      description: `${touch.assignee} · ${changeLabel(touch.change)}`,
      detail: `${touch.rig} — ${touch.workDir}`,
      touch,
    })),
    {
      title: `Worktrees editing ${rel}`,
      placeHolder: "Open the read-only worktree diff",
      matchOnDescription: true,
    },
  );
  if (!picked) return;
  await openTouch(picked.touch);
}

/** Open a touch's worktree diff via codeNav (loose coupling); fall back to copying its path. */
async function openTouch(touch: FileTouch): Promise<void> {
  try {
    await vscode.commands.executeCommand(SHOW_DIFF_CMD, { kind: "bead", city: touch.city, beadId: touch.beadId });
  } catch {
    await vscode.env.clipboard.writeText(touch.workDir);
    void vscode.window.showInformationMessage(`Copied worktree path: ${touch.workDir}`);
  }
}

/**
 * Register the worktree code lens. Returns a handle the feature uses to refresh
 * on connection changes; all disposables are pushed onto `context.subscriptions`.
 */
export function registerWorktreeLens(
  context: vscode.ExtensionContext,
  deps: WorktreeLensDeps,
): { refresh: () => void } {
  const controller = new WorktreeLensController(deps);

  context.subscriptions.push(
    controller,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, new WorktreeLensCodeLensProvider(controller)),
    vscode.window.registerFileDecorationProvider(new WorktreeLensDecorationProvider(controller)),
    vscode.commands.registerCommand(CMD.show, (relPath?: string) => showTouches(controller, relPath)),
    vscode.commands.registerCommand(CMD.refresh, () => controller.trigger()),
    vscode.workspace.onDidChangeConfiguration((event) => controller.onConfigChange(event)),
  );

  controller.start();
  return { refresh: () => controller.trigger() };
}
