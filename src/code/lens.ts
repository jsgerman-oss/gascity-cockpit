// Worktree code-lens core (cockpit-21l.8): the inverse of worktree.ts.
//
// worktree.ts answers "what does *this bead's* worktree change?" (bead → diff).
// This answers the other direction — "which in-flight beads/polecats are touching
// *this file* right now?" (file → beads) — so the editor can annotate a file with
// the other worktrees editing it and an operator sees a collision before it
// happens (PRD: "the code my agents are working on lives in polecat worktrees I
// have to find").
//
// Pure: no `vscode`, `git`, or `fs`. The glue (../views/worktreeLens.ts) runs the
// read-only git that produces each worktree's changed-file list and feeds it in;
// everything here is data-shaping and formatting, unit-tested in lens.test.ts.
import { changeLabel, resolveWorktree, type Bead, type DiffChange, type DiffFile } from "./worktree.ts";
import { beadAssignee, beadRig } from "../beads/status.ts";

/**
 * Normalise a path for cross-worktree comparison. Git emits repo-relative paths
 * with forward slashes; `vscode.workspace.asRelativePath` may use OS separators.
 * Funnelling both through here makes the index key consistent: backslashes become
 * forward slashes and a leading `./` is dropped.
 */
export function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Normalise an absolute worktree path for identity comparison (drop trailing slashes). */
function normalizeWorkDir(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** A repo-relative path a worktree changes, with its change kind. */
export interface TouchedFile {
  /** Normalised repo-relative path. */
  path: string;
  change: DiffChange;
}

/** One worktree's in-flight footprint: a bead/polecat and the paths it touches. */
export interface WorktreeActivity {
  beadId: string;
  /** Supervisor city the bead belongs to (needed to navigate to its diff). */
  city: string;
  title: string;
  /** Display name of the polecat/agent doing the work (from the bead assignee). */
  assignee: string;
  /** Rig the bead belongs to, for cross-rig disambiguation. */
  rig: string;
  /** Absolute worktree path (`metadata.work_dir`). */
  workDir: string;
  /** Source branch, when recorded (`metadata.branch`). */
  branch?: string;
  /** Repo-relative paths this worktree changes, de-duplicated. */
  files: readonly TouchedFile[];
}

/** A single worktree touching a queried file. */
export interface FileTouch {
  beadId: string;
  city: string;
  title: string;
  assignee: string;
  rig: string;
  workDir: string;
  branch?: string;
  change: DiffChange;
}

/** A placeholder rig (see {@link beadRig}) is parenthesised; suppress it in labels. */
function isPlaceholderRig(rig: string): boolean {
  return rig.startsWith("(");
}

/**
 * Display name for the agent touching a file. `beadAssignee` yields the raw
 * assignee (`rig/agent`, a session name, or `(unassigned)`); a `rig/agent`
 * assignee is shortened to `agent` since the rig is carried separately.
 */
function displayAssignee(bead: Bead): string {
  const assignee = beadAssignee(bead);
  const slash = assignee.lastIndexOf("/");
  return slash >= 0 ? assignee.slice(slash + 1) : assignee;
}

/** De-duplicate changed files by normalised path, keeping the first change seen. */
export function dedupeTouchedFiles(files: readonly DiffFile[]): TouchedFile[] {
  const byPath = new Map<string, DiffChange>();
  for (const file of files) {
    const path = normalizeRepoPath(file.path);
    if (!path) continue;
    if (!byPath.has(path)) byPath.set(path, file.change);
  }
  return [...byPath].map(([path, change]) => ({ path, change }));
}

/**
 * Build a worktree's activity from its bead, the city it lives in, and the
 * changed files its git diff reported (committed range and working tree
 * concatenated — this de-dupes them). Returns `null` when the bead records no
 * worktree (unclaimed, or not yet at branch-setup): there is nothing to attribute
 * a file touch to.
 */
export function buildActivity(bead: Bead, city: string, changedFiles: readonly DiffFile[]): WorktreeActivity | null {
  const ref = resolveWorktree(bead);
  if (!ref) return null;
  const activity: WorktreeActivity = {
    beadId: bead.id,
    city,
    title: bead.title ?? "",
    assignee: displayAssignee(bead),
    rig: beadRig(bead),
    workDir: ref.workDir,
    files: dedupeTouchedFiles(changedFiles),
  };
  if (ref.branch) activity.branch = ref.branch;
  return activity;
}

/**
 * Index of in-flight worktree activity, keyed by repo-relative path so a per-file
 * lookup is O(1). Build it once per refresh from the active worktrees; query it
 * per file the editor renders.
 */
export class WorktreeActivityIndex {
  private readonly byPath = new Map<string, FileTouch[]>();
  private readonly activities: readonly WorktreeActivity[];

  constructor(activities: readonly WorktreeActivity[]) {
    this.activities = activities;
    for (const activity of activities) {
      const base = {
        beadId: activity.beadId,
        city: activity.city,
        title: activity.title,
        assignee: activity.assignee,
        rig: activity.rig,
        workDir: activity.workDir,
        ...(activity.branch ? { branch: activity.branch } : {}),
      };
      for (const file of activity.files) {
        const touch: FileTouch = { ...base, change: file.change };
        const list = this.byPath.get(file.path);
        if (list) list.push(touch);
        else this.byPath.set(file.path, [touch]);
      }
    }
  }

  /** The worktrees touching a repo-relative path, in stable order (by bead id). */
  touching(repoRelPath: string): FileTouch[] {
    const list = this.byPath.get(normalizeRepoPath(repoRelPath));
    if (!list) return [];
    return [...list].sort((a, b) => a.beadId.localeCompare(b.beadId));
  }

  /** Every repo-relative path that has activity (for scoping a decoration refresh). */
  paths(): string[] {
    return [...this.byPath.keys()];
  }

  /** Number of worktrees indexed. */
  get worktreeCount(): number {
    return this.activities.length;
  }

  /** Number of distinct touched paths. */
  get pathCount(): number {
    return this.byPath.size;
  }
}

/** Options for {@link buildIndex}. */
export interface BuildIndexOptions {
  /**
   * Exclude the worktree at this absolute path — e.g. the operator's own
   * checkout, so the lens never flags a file as "also" edited by yourself.
   */
  excludeWorkDir?: string;
}

/** Build a {@link WorktreeActivityIndex}, optionally excluding one worktree. */
export function buildIndex(
  activities: readonly WorktreeActivity[],
  opts: BuildIndexOptions = {},
): WorktreeActivityIndex {
  const exclude = opts.excludeWorkDir ? normalizeWorkDir(opts.excludeWorkDir) : undefined;
  const kept = exclude ? activities.filter((a) => normalizeWorkDir(a.workDir) !== exclude) : activities;
  return new WorktreeActivityIndex(kept);
}

const EYE = "$(eye)";

/**
 * Compact one-line summary for a file's touches, suitable for a CodeLens title
 * (codicons render). Empty string when nothing touches the file.
 */
export function touchSummary(touches: readonly FileTouch[]): string {
  if (touches.length === 0) return "";
  if (touches.length === 1) {
    const only = touches[0];
    return `${EYE} Also editing: ${only.beadId} · ${only.assignee}`;
  }
  return `${EYE} ${touches.length} worktrees editing this file`;
}

/** Multi-line detail listing each worktree touching the file (for a tooltip). */
export function touchDetail(touches: readonly FileTouch[]): string {
  return touches
    .map((touch) => {
      const rig = isPlaceholderRig(touch.rig) ? "" : ` (${touch.rig})`;
      return `${touch.beadId} · ${touch.assignee} — ${changeLabel(touch.change)}${rig}`;
    })
    .join("\n");
}

/** A file-decoration badge (≤2 chars) and tooltip; `null` when nothing touches the file. */
export function touchDecoration(touches: readonly FileTouch[]): { badge: string; tooltip: string } | null {
  if (touches.length === 0) return null;
  const badge = touches.length === 1 ? "●" : touches.length > 9 ? "9+" : String(touches.length);
  return { badge, tooltip: `Worktree lens — also editing:\n${touchDetail(touches)}` };
}
