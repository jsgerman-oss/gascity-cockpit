// Bead → polecat worktree → diff resolution (PRD user stories 27–29).
//
// There is no /v0 endpoint for a worktree diff: a work bead records the absolute
// path to its git worktree and the branch/target of the work in flight as
// metadata (PRD "Work Bead Metadata Contract"). This module turns that metadata
// into a `WorktreeRef`, and builds the read-only git plumbing the glue runs to
// show the diff. It is provider-agnostic — no `vscode`, no `child_process`, no
// `fs` — so the resolution, argument-building, and `--name-status` parsing are
// unit-testable (Seam 1). The thin glue in `../views/codeNav.ts` runs git and
// renders the result read-only, so an agent sandbox is never edited (story 29).
import type { Schema } from "../api/types.ts";

/** A bead as returned by the /v0 contract. */
export type Bead = Schema<"Bead">;

/** Metadata key holding the absolute worktree path (set at branch-setup). */
export const WORK_DIR_KEY = "work_dir";
/** Metadata key holding the source branch of the work. */
export const BRANCH_KEY = "branch";
/** Metadata key holding the target branch the work merges into. */
export const TARGET_KEY = "target";
/** Target branch assumed when a bead records no explicit `target`. */
export const DEFAULT_TARGET_BRANCH = "main";

/** A resolved pointer to a bead's polecat worktree and the work in flight. */
export interface WorktreeRef {
  /** Absolute path to the git worktree (`metadata.work_dir`). */
  workDir: string;
  /** Source branch of the work, when recorded (`metadata.branch`). */
  branch?: string;
  /** Target branch the work merges into (`metadata.target`, default `main`). */
  target: string;
}

/**
 * Resolve a bead's worktree from its metadata, or `null` when none is recorded
 * yet (the bead is unclaimed, or its polecat has not reached branch-setup). The
 * worktree path is the load-bearing field; branch is informational and target
 * defaults to `main`.
 */
export function resolveWorktree(bead: Bead): WorktreeRef | null {
  const meta = bead.metadata ?? {};
  const workDir = (meta[WORK_DIR_KEY] ?? "").trim();
  if (!workDir) return null;
  const branch = (meta[BRANCH_KEY] ?? "").trim();
  const target = (meta[TARGET_KEY] ?? "").trim() || DEFAULT_TARGET_BRANCH;
  const ref: WorktreeRef = { workDir, target };
  if (branch) ref.branch = branch;
  return ref;
}

/**
 * Git revision range for "the diff of this bead's work": the changes the branch
 * introduced since it diverged from the target — the three-dot range, the same
 * set a pull request shows. Always valid (target defaults to `main`); if the
 * target ref is missing in the worktree the glue falls back to `workingRange`.
 */
export function committedRange(ref: WorktreeRef): string {
  return `${ref.target}...HEAD`;
}

/** Fallback range: the working tree against HEAD (uncommitted changes only). */
export function workingRange(): string {
  return "HEAD";
}

/** `git` args (after the program) for a unified diff over `range`, optionally scoped to `paths`. */
export function unifiedDiffArgs(range: string, paths: string[] = []): string[] {
  const args = ["diff", range];
  if (paths.length > 0) args.push("--", ...paths);
  return args;
}

/** `git` args for the machine-readable name+status list over `range`. */
export function nameStatusArgs(range: string): string[] {
  return ["diff", "--name-status", range];
}

/** Normalised change kind for a file in a diff. */
export type DiffChange =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unknown";

/** A single changed file parsed from `git diff --name-status`. */
export interface DiffFile {
  /** Normalised change kind. */
  change: DiffChange;
  /** Path in the branch (the new path for renames/copies). */
  path: string;
  /** Original path, for renames/copies. */
  oldPath?: string;
  /** Raw git status token, e.g. `M`, `A`, `R100`. */
  raw: string;
}

function changeFromCode(code: string): DiffChange {
  switch (code) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "T":
      return "type-changed";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "unknown";
  }
}

/**
 * Parse `git diff --name-status` output into structured per-file changes. Lines
 * are TAB-separated: `STATUS<TAB>PATH`, or for renames/copies `Rxxx<TAB>OLD<TAB>NEW`.
 * Blank and unparseable lines are skipped.
 */
export function parseNameStatus(stdout: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const raw = parts[0] ?? "";
    const code = raw.charAt(0).toUpperCase();
    if ((code === "R" || code === "C") && parts.length >= 3) {
      files.push({ change: changeFromCode(code), oldPath: parts[1], path: parts[parts.length - 1], raw });
    } else if (parts.length >= 2 && parts[parts.length - 1]) {
      files.push({ change: changeFromCode(code), path: parts[parts.length - 1], raw });
    }
  }
  return files;
}

/** Aggregate counts over a set of changed files. */
export interface DiffSummary {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  other: number;
}

/** Tally a parsed file list into a `DiffSummary`. */
export function summarizeDiff(files: DiffFile[]): DiffSummary {
  const summary: DiffSummary = { total: files.length, added: 0, modified: 0, deleted: 0, renamed: 0, other: 0 };
  for (const file of files) {
    switch (file.change) {
      case "added":
        summary.added++;
        break;
      case "modified":
        summary.modified++;
        break;
      case "deleted":
        summary.deleted++;
        break;
      case "renamed":
      case "copied":
        summary.renamed++;
        break;
      default:
        summary.other++;
    }
  }
  return summary;
}

/** A compact one-line description of a diff, e.g. `4 files · +1 ~2 -1`. */
export function summaryLine(summary: DiffSummary): string {
  if (summary.total === 0) return "no changes";
  const noun = summary.total === 1 ? "file" : "files";
  const parts: string[] = [];
  if (summary.added) parts.push(`+${summary.added}`);
  if (summary.modified) parts.push(`~${summary.modified}`);
  if (summary.deleted) parts.push(`-${summary.deleted}`);
  if (summary.renamed) parts.push(`»${summary.renamed}`);
  if (summary.other) parts.push(`?${summary.other}`);
  return `${summary.total} ${noun}${parts.length ? ` · ${parts.join(" ")}` : ""}`;
}

/** Human-readable label for a change kind (for quick-pick rows). */
export function changeLabel(change: DiffChange): string {
  switch (change) {
    case "type-changed":
      return "type changed";
    case "unknown":
      return "changed";
    default:
      return change;
  }
}

/** Single-letter badge for a change kind (for quick-pick detail). */
export function changeBadge(change: DiffChange): string {
  switch (change) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "type-changed":
      return "T";
    default:
      return "?";
  }
}
