// Domain model for the in-editor merge-queue review (cockpit-21l.2).
//
// The merge queue is not a `/v0` endpoint — it is *derived* from beads. When a
// polecat finishes it pushes a branch and hands the work bead to the refinery
// (assignee `<rig>/gastown.refinery`) with the branch/target — and, for rigs
// with a GitHub remote, a `pr_url` — recorded as metadata (the "Work Bead
// Metadata Contract"). The refinery then merges it and records
// `merge_result`/`merged_sha`, or kicks it back with `rejection_reason`. This
// module turns that lifecycle into a reviewable queue.
//
// Like the rest of the domain layer it is provider-agnostic (no `vscode`), so it
// is unit-tested in plain Node against bead fixtures (PRD Testing Decisions,
// Seam 1). The thin VS Code glue lives in `../views/mergeQueue.ts`.
import type { Bead, BeadRecord } from "../beads/types.ts";

export type { Bead, BeadRecord };

/** Where a bead sits in the refinery merge lifecycle. */
export type MergeState = "awaiting" | "rejected" | "merged";

/**
 * A bead surfaced in the merge queue, flattened to exactly what the review UI
 * needs. State-specific fields (`rejectionReason`, `mergedSha`) are only set in
 * the state they belong to, so a re-submitted bead never shows a stale rejection.
 */
export interface MergeQueueEntry {
  /** City the bead belongs to. */
  city: string;
  /** Bead id. */
  beadId: string;
  /** Bead title. */
  title: string;
  /** Current assignee — the refinery while awaiting, the rework polecat (or empty pool) while rejected. */
  assignee: string;
  /** Lifecycle state in the queue. */
  state: MergeState;
  /** Source branch carrying the work (`metadata.branch`), when recorded. */
  branch?: string;
  /** Target branch the work merges into (`metadata.target`, default `main`). */
  target: string;
  /** Pull-request URL the refinery recorded (`metadata.pr_url` / `existing_pr`), when any. */
  prUrl?: string;
  /** Why the refinery kicked the work back (`metadata.rejection_reason`) — only when `state` is `rejected`. */
  rejectionReason?: string;
  /** Merge commit sha (`metadata.merged_sha`) — only when `state` is `merged`. */
  mergedSha?: string;
  /** Absolute worktree path (`metadata.work_dir`), when recorded — needed to show the diff in-editor. */
  workDir?: string;
  /** Bead priority, for ordering within a state. */
  priority?: number;
}

/** Per-state tallies for view headers and empty states. */
export interface MergeQueueSummary {
  total: number;
  awaiting: number;
  rejected: number;
  merged: number;
}

// --- Tree node model (a pure structure the VS Code provider walks) ----------

export interface MergeGroupNode {
  kind: "group";
  id: string;
  state: MergeState;
  label: string;
  count: number;
  children: MergeEntryNode[];
}

export interface MergeEntryNode {
  kind: "entry";
  id: string;
  entry: MergeQueueEntry;
}

/** A non-entry informational row (empty state, load error). */
export interface MergeMessageNode {
  kind: "message";
  id: string;
  label: string;
  detail?: string;
  icon?: string;
  /** `ThemeColor` id tinting the icon (e.g. the error red); see `../ui/view-state`. */
  iconColor?: string;
}

export type MergeQueueNode = MergeGroupNode | MergeEntryNode | MergeMessageNode;
