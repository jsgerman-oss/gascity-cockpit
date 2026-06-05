// Public surface of the merge-queue review domain layer (cockpit-21l.2).
//
// The VS Code glue in `../views/mergeQueue.ts` imports from here. This barrel
// stays free of `vscode` so the whole layer remains unit-testable against bead
// fixtures; the editor- and git-bound side-effects live only in the glue.
export type {
  Bead,
  BeadRecord,
  MergeEntryNode,
  MergeGroupNode,
  MergeMessageNode,
  MergeQueueEntry,
  MergeQueueNode,
  MergeQueueSummary,
  MergeState,
} from "./types.ts";

export {
  deriveMergeQueue,
  EXISTING_PR_KEY,
  isRefineryAssignee,
  MERGE_RESULT_KEY,
  MERGE_RESULT_MERGED,
  MERGED_SHA_KEY,
  mergeStateOf,
  PR_URL_KEY,
  REFINERY_ROLE,
  REJECTION_REASON_KEY,
  STATE_RANK,
  summarize,
  toEntry,
} from "./derive.ts";

export {
  branchLine,
  buildQueueTree,
  entryDescription,
  entryLabel,
  entryTooltip,
  loadErrorNode,
  prRef,
  stateIcon,
  stateLabel,
} from "./format.ts";
