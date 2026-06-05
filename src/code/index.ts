// Public surface of the code/worktree navigation domain (PRD stories 27–29).
//
// The VS Code glue in `../views/codeNav.ts` imports from here. This barrel stays
// free of `vscode` (and of `fs`/`child_process`) so the whole layer remains
// unit-testable; the editor- and git-bound side-effects live only in the glue.
export {
  BRANCH_KEY,
  changeBadge,
  changeLabel,
  committedRange,
  DEFAULT_TARGET_BRANCH,
  nameStatusArgs,
  parseNameStatus,
  resolveWorktree,
  summarizeDiff,
  summaryLine,
  TARGET_KEY,
  unifiedDiffArgs,
  WORK_DIR_KEY,
  workingRange,
  type Bead,
  type DiffChange,
  type DiffFile,
  type DiffSummary,
  type WorktreeRef,
} from "./worktree.ts";
