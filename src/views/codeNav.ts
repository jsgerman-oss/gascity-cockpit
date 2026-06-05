/**
 * VS Code glue for bead → worktree → diff navigation (PRD stories 27–29).
 *
 * Intentionally thin (PRD Testing Decisions: the editor-bound layer is excluded
 * from heavy unit testing). The resolution + git-plumbing logic lives in the
 * tested, `vscode`-free `../code` core; this file runs read-only git and renders
 * the result so an agent sandbox is never edited (story 29):
 *
 *   - The diff is served through a `TextDocumentContentProvider`, so the document
 *     is inherently read-only — there is nothing to save back into the worktree.
 *   - The only git commands issued are `git diff` / `git diff --name-status`,
 *     both read-only.
 *   - "Open Folder" / "Reveal in OS" are explicit escape hatches that warn the
 *     target is a live agent worktree.
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import {
  BeadsApiError,
  type BeadsRepository,
  type BeadTreeNode,
} from "../beads/index.ts";
import {
  changeBadge,
  changeLabel,
  committedRange,
  nameStatusArgs,
  parseNameStatus,
  resolveWorktree,
  summarizeDiff,
  summaryLine,
  unifiedDiffArgs,
  workingRange,
  type DiffFile,
  type WorktreeRef,
} from "../code/index.ts";

const execFileAsync = promisify(execFile);

const SCHEME = "gascity-worktree";
/** Cap git output so a runaway diff cannot exhaust memory (20 MiB). */
const GIT_MAX_BUFFER = 20 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;

const CMD = {
  openWorktree: "gascityCockpit.code.openWorktree",
  showDiff: "gascityCockpit.code.showDiff",
  browseFiles: "gascityCockpit.code.browseChangedFiles",
} as const;

export interface CodeNavDeps {
  repository: BeadsRepository;
}

interface BeadTarget {
  city: string;
  beadId: string;
}

/** Outcome of a read-only git invocation in a worktree. */
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
 * Produce the unified diff for a worktree, preferring the committed PR range
 * (`target...HEAD`) and falling back to the working tree when that range is not
 * resolvable (e.g. the target ref is absent in the worktree).
 */
async function computeDiff(ref: WorktreeRef): Promise<{ body: string; usedRange: string }> {
  const primary = committedRange(ref);
  const first = await runGit(ref.workDir, unifiedDiffArgs(primary));
  if (first.ok) return { body: first.stdout, usedRange: primary };

  const fallback = workingRange();
  const second = await runGit(ref.workDir, unifiedDiffArgs(fallback));
  if (second.ok) return { body: second.stdout, usedRange: fallback };

  // Both failed — surface git's error inside the diff doc as a comment block.
  return {
    body: `# Unable to compute diff in ${ref.workDir}\n# ${first.stderr.trim() || second.stderr.trim()}\n`,
    usedRange: primary,
  };
}

async function computeChangedFiles(ref: WorktreeRef): Promise<DiffFile[]> {
  const primary = await runGit(ref.workDir, nameStatusArgs(committedRange(ref)));
  if (primary.ok) return parseNameStatus(primary.stdout);
  const fallback = await runGit(ref.workDir, nameStatusArgs(workingRange()));
  return fallback.ok ? parseNameStatus(fallback.stdout) : [];
}

/**
 * Read-only content provider for worktree diffs. The whole document is a virtual
 * resource the user cannot save, which is exactly the read-only guarantee story
 * 29 requires. The URI query carries everything needed to recompute the diff, so
 * rendering never depends on the supervisor API being connected.
 */
class WorktreeDiffProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const workDir = params.get("workDir") ?? "";
    const target = params.get("target") ?? "main";
    const branch = params.get("branch") ?? undefined;
    const file = params.get("file") ?? undefined;
    if (!workDir) return "# No worktree path recorded for this bead.\n";

    const ref: WorktreeRef = branch ? { workDir, target, branch } : { workDir, target };
    const range = committedRange(ref);
    const header = headerLines(params.get("beadId") ?? "", ref, file);

    if (file) {
      const res = await runGit(workDir, unifiedDiffArgs(range, [file]));
      const body = res.ok ? res.stdout : (await runGit(workDir, unifiedDiffArgs(workingRange(), [file]))).stdout;
      return `${header}${body || "# (no textual changes — binary or mode-only)\n"}`;
    }

    const { body } = await computeDiff(ref);
    return `${header}${body || "# No changes on this branch relative to its target.\n"}`;
  }
}

function headerLines(beadId: string, ref: WorktreeRef, file?: string): string {
  const lines = [
    `# Worktree diff${beadId ? ` for ${beadId}` : ""}`,
    `# ${ref.workDir}`,
    `# range: ${committedRange(ref)}${ref.branch ? ` (branch ${ref.branch})` : ""}`,
  ];
  if (file) lines.push(`# file: ${file}`);
  lines.push("# (read-only — agent worktrees are never edited from the Cockpit)", "");
  return lines.join("\n");
}

function diffUri(target: BeadTarget, ref: WorktreeRef, file?: string): vscode.Uri {
  const query = new URLSearchParams({ beadId: target.beadId, workDir: ref.workDir, target: ref.target });
  if (ref.branch) query.set("branch", ref.branch);
  if (file) query.set("file", file);
  const path = file ? `/${target.beadId}/${file}.diff` : `/${target.beadId}.diff`;
  return vscode.Uri.from({ scheme: SCHEME, path, query: query.toString() });
}

/** Resolve a bead's worktree, messaging the user when it cannot be navigated. */
async function resolveTarget(
  deps: CodeNavDeps,
  node: BeadTreeNode | undefined,
): Promise<{ target: BeadTarget; ref: WorktreeRef } | null> {
  const target = asBeadTarget(node);
  if (!target) {
    void vscode.window.showInformationMessage("Open this from a bead in the Beads explorer.");
    return null;
  }

  let ref: WorktreeRef | null;
  try {
    const bead = await deps.repository.getBead(target.city, target.beadId);
    ref = resolveWorktree(bead);
  } catch (err) {
    const detail = err instanceof BeadsApiError ? err.message : String(err);
    void vscode.window.showErrorMessage(`Could not load ${target.beadId}: ${detail}`);
    return null;
  }

  if (!ref) {
    void vscode.window.showInformationMessage(
      `${target.beadId} has no worktree yet — it is unclaimed or hasn't reached branch-setup.`,
    );
    return null;
  }

  if (!(await pathExists(ref.workDir))) {
    void vscode.window.showWarningMessage(
      `Recorded worktree for ${target.beadId} is gone (the polecat may have finished and cleaned up):\n${ref.workDir}`,
    );
    return null;
  }
  return { target, ref };
}

async function openDiff(target: BeadTarget, ref: WorktreeRef, file?: string): Promise<void> {
  const uri = diffUri(target, ref, file);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, "diff");
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function browseChangedFiles(target: BeadTarget, ref: WorktreeRef): Promise<void> {
  const files = await computeChangedFiles(ref);
  if (files.length === 0) {
    void vscode.window.showInformationMessage(`${target.beadId}: no changed files on this branch.`);
    return;
  }
  const summary = summaryLine(summarizeDiff(files));
  const picked = await vscode.window.showQuickPick(
    files.map((f) => ({
      label: `$(diff) ${f.path}`,
      description: `${changeBadge(f.change)} ${changeLabel(f.change)}`,
      detail: f.oldPath ? `from ${f.oldPath}` : undefined,
      file: f,
    })),
    { title: `Changed files — ${summary}`, placeHolder: "Open a file's diff (read-only)", matchOnDescription: true },
  );
  if (picked) await openDiff(target, ref, picked.file.path);
}

async function openWorktreeMenu(target: BeadTarget, ref: WorktreeRef): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "$(diff) Show Diff", id: "diff", detail: `${committedRange(ref)} in ${ref.workDir}` },
      { label: "$(list-tree) Browse Changed Files (read-only)", id: "files" },
      { label: "$(folder-opened) Open Folder in New Window", id: "folder", detail: "Live agent worktree — avoid editing" },
      { label: "$(file-symlink-directory) Reveal in OS", id: "reveal" },
      { label: "$(clippy) Copy Worktree Path", id: "copy" },
    ],
    { title: `Worktree for ${target.beadId}`, placeHolder: ref.workDir },
  );
  if (!choice) return;
  const dirUri = vscode.Uri.file(ref.workDir);
  switch (choice.id) {
    case "diff":
      await openDiff(target, ref);
      break;
    case "files":
      await browseChangedFiles(target, ref);
      break;
    case "folder":
      await vscode.commands.executeCommand("vscode.openFolder", dirUri, { forceNewWindow: true });
      break;
    case "reveal":
      await vscode.commands.executeCommand("revealFileInOS", dirUri);
      break;
    case "copy":
      await vscode.env.clipboard.writeText(ref.workDir);
      void vscode.window.showInformationMessage(`Copied ${ref.workDir}`);
      break;
  }
}

export function registerCodeNav(context: vscode.ExtensionContext, deps: CodeNavDeps): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new WorktreeDiffProvider()),
    vscode.commands.registerCommand(CMD.openWorktree, async (node?: BeadTreeNode) => {
      const resolved = await resolveTarget(deps, node);
      if (resolved) await openWorktreeMenu(resolved.target, resolved.ref);
    }),
    vscode.commands.registerCommand(CMD.showDiff, async (node?: BeadTreeNode) => {
      const resolved = await resolveTarget(deps, node);
      if (resolved) await openDiff(resolved.target, resolved.ref);
    }),
    vscode.commands.registerCommand(CMD.browseFiles, async (node?: BeadTreeNode) => {
      const resolved = await resolveTarget(deps, node);
      if (resolved) await browseChangedFiles(resolved.target, resolved.ref);
    }),
  );
}

function asBeadTarget(node: BeadTreeNode | undefined): BeadTarget | null {
  if (node && node.kind === "bead") return { city: node.city, beadId: node.beadId };
  return null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
