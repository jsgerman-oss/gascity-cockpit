// Derivation: beads → merge-queue entries.
//
// Reuses the worktree metadata keys from the `../code` core (branch/target/
// work_dir are the same fields the diff navigation reads) and adds the
// refinery-handoff keys the cockpit needs to tell a queued bead from ordinary
// in-flight work. No `vscode` here — see `./types.ts`.
import { BRANCH_KEY, DEFAULT_TARGET_BRANCH, TARGET_KEY, WORK_DIR_KEY } from "../code/index.ts";
import type { Bead, BeadRecord, MergeQueueEntry, MergeQueueSummary, MergeState } from "./types.ts";

/** Metadata key: the PR url the refinery records once a PR exists. */
export const PR_URL_KEY = "pr_url";
/** Metadata key: a pre-existing PR url supplied to the refinery before dispatch. */
export const EXISTING_PR_KEY = "existing_pr";
/** Metadata key: why the refinery rejected the work (set on kick-back). */
export const REJECTION_REASON_KEY = "rejection_reason";
/** Metadata key: the refinery's merge outcome (`merged` once it lands). */
export const MERGE_RESULT_KEY = "merge_result";
/** Metadata key: the merge commit sha the refinery records on a successful merge. */
export const MERGED_SHA_KEY = "merged_sha";

/** The value of `merge_result` that means the work landed on the target branch. */
export const MERGE_RESULT_MERGED = "merged";

/** The refinery role suffix an assignee carries, e.g. `gascity-cockpit/gastown.refinery`. */
export const REFINERY_ROLE = "gastown.refinery";

/** State ordering for display: actionable first (awaiting, then rework), history last. */
export const STATE_RANK: Record<MergeState, number> = { awaiting: 0, rejected: 1, merged: 2 };

/**
 * True when an assignee names a refinery — the merge-queue owner. Matches the
 * bare role (`gastown.refinery`), the rig-qualified form
 * (`<rig>/gastown.refinery`), and tolerates any other `*.refinery` agent so a
 * non-default refinery naming still surfaces in the queue.
 */
export function isRefineryAssignee(assignee: string | undefined | null): boolean {
  const a = (assignee ?? "").trim();
  if (!a) return false;
  const base = a.includes("/") ? a.slice(a.lastIndexOf("/") + 1) : a;
  return base === "refinery" || base.endsWith(".refinery");
}

function meta(bead: Bead, key: string): string {
  return (bead.metadata?.[key] ?? "").trim();
}

/**
 * The merge-lifecycle state of a bead, or `null` when it is not in the queue at
 * all. Precedence: a landed merge wins (it is history, regardless of who holds
 * the bead now); otherwise a bead held by the refinery is awaiting merge;
 * otherwise a recorded `rejection_reason` means it was kicked back for rework.
 * A plain in-flight polecat bead — no refinery handoff, no rejection, not merged
 * — returns `null` so ordinary work never pollutes the queue.
 */
export function mergeStateOf(bead: Bead): MergeState | null {
  if (meta(bead, MERGE_RESULT_KEY) === MERGE_RESULT_MERGED) return "merged";
  if (isRefineryAssignee(bead.assignee)) return "awaiting";
  if (meta(bead, REJECTION_REASON_KEY)) return "rejected";
  return null;
}

function prUrlOf(bead: Bead): string | undefined {
  return meta(bead, PR_URL_KEY) || meta(bead, EXISTING_PR_KEY) || undefined;
}

/** Build a queue entry from a city-scoped record, or `null` when it is out of queue. */
export function toEntry(record: BeadRecord): MergeQueueEntry | null {
  const { bead, city } = record;
  const state = mergeStateOf(bead);
  if (!state) return null;

  const entry: MergeQueueEntry = {
    city,
    beadId: bead.id,
    title: bead.title,
    assignee: (bead.assignee ?? "").trim(),
    state,
    target: meta(bead, TARGET_KEY) || DEFAULT_TARGET_BRANCH,
  };

  const branch = meta(bead, BRANCH_KEY);
  if (branch) entry.branch = branch;
  const workDir = meta(bead, WORK_DIR_KEY);
  if (workDir) entry.workDir = workDir;
  const prUrl = prUrlOf(bead);
  if (prUrl) entry.prUrl = prUrl;
  if (typeof bead.priority === "number") entry.priority = bead.priority;

  // State-specific fields: keep them scoped so a re-submitted bead (back with the
  // refinery) never carries a stale rejection, and only merged beads show a sha.
  if (state === "rejected") {
    const reason = meta(bead, REJECTION_REASON_KEY);
    if (reason) entry.rejectionReason = reason;
  } else if (state === "merged") {
    const sha = meta(bead, MERGED_SHA_KEY);
    if (sha) entry.mergedSha = sha;
  }

  return entry;
}

/**
 * Derive the merge queue from loaded bead records. Entries are ordered by state
 * (awaiting → rejected → merged), then ascending priority, then bead id, so the
 * result is stable across refreshes (and deterministic in tests).
 */
export function deriveMergeQueue(records: readonly BeadRecord[]): MergeQueueEntry[] {
  const entries: MergeQueueEntry[] = [];
  for (const record of records) {
    const entry = toEntry(record);
    if (entry) entries.push(entry);
  }
  entries.sort(compareEntries);
  return entries;
}

function compareEntries(a: MergeQueueEntry, b: MergeQueueEntry): number {
  const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (byState !== 0) return byState;
  const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
  const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return a.beadId.localeCompare(b.beadId);
}

/** Tally entries by state. */
export function summarize(entries: readonly MergeQueueEntry[]): MergeQueueSummary {
  const summary: MergeQueueSummary = { total: entries.length, awaiting: 0, rejected: 0, merged: 0 };
  for (const e of entries) summary[e.state]++;
  return summary;
}
