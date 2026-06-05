// Presentation helpers for the merge-queue review: state labels/icons, the
// branch→target line, a compact PR reference, the entry tooltip, and the
// grouping that turns a flat entry list into the tree the provider walks. Pure
// string/structure work — no `vscode` — so it is unit-tested directly.
import { emptyNotice, errorNotice, loadingNotice, type StateNotice } from "../ui/index.ts";
import { STATE_RANK } from "./derive.ts";
import type {
  MergeEntryNode,
  MergeGroupNode,
  MergeMessageNode,
  MergeQueueEntry,
  MergeQueueNode,
  MergeState,
} from "./types.ts";

/** Group heading for each lifecycle state. */
export function stateLabel(state: MergeState): string {
  switch (state) {
    case "awaiting":
      return "Awaiting merge";
    case "rejected":
      return "Needs rework";
    case "merged":
      return "Recently merged";
  }
}

/** A VS Code codicon id (without the `$(...)` wrapper) representing each state. */
export function stateIcon(state: MergeState): string {
  switch (state) {
    case "awaiting":
      return "git-pull-request";
    case "rejected":
      return "warning";
    case "merged":
      return "git-merge";
  }
}

/** Short `branch → target` line, e.g. `gc-furiosa-abc → main`. */
export function branchLine(entry: MergeQueueEntry): string {
  return `${entry.branch ?? "(no branch)"} → ${entry.target}`;
}

/**
 * A compact label for a PR url, e.g. `github.com #123` (GitHub pulls) or
 * `gitlab.com #5` (GitLab merge requests), falling back to just the host, or
 * `PR` when the string is not a parseable url. Never throws.
 */
export function prRef(prUrl: string): string {
  try {
    const url = new URL(prUrl);
    const host = url.hostname.replace(/^www\./, "");
    const match = url.pathname.match(/\/pull\/(\d+)/) ?? url.pathname.match(/\/merge_requests\/(\d+)/);
    const num = match ? `#${match[1]}` : "";
    return [host, num].filter(Boolean).join(" ") || "PR";
  } catch {
    return "PR";
  }
}

/** The primary tree label for an entry — the bead id. */
export function entryLabel(entry: MergeQueueEntry): string {
  return entry.beadId;
}

/** The dimmed description beside the label — the bead title. */
export function entryDescription(entry: MergeQueueEntry): string {
  return entry.title;
}

/** Markdown tooltip summarising the entry's handoff state for hover. */
export function entryTooltip(entry: MergeQueueEntry): string {
  const lines = [
    `**${entry.beadId}** — ${entry.title}`,
    "",
    `State: ${stateLabel(entry.state)}`,
    `Branch: \`${entry.branch ?? "—"}\` → \`${entry.target}\``,
  ];
  if (entry.assignee) lines.push(`Assignee: \`${entry.assignee}\``);
  if (entry.prUrl) lines.push(`PR: ${prRef(entry.prUrl)} — ${entry.prUrl}`);
  if (entry.rejectionReason) lines.push("", `⚠ Rejected: ${entry.rejectionReason}`);
  if (entry.mergedSha) lines.push(`Merged: \`${entry.mergedSha.slice(0, 12)}\``);
  if (!entry.workDir) lines.push("", "_No worktree recorded — the in-editor diff is unavailable._");
  return lines.join("\n");
}

/** Map a shared {@link StateNotice} onto a merge-queue message row. */
function messageNode(id: string, notice: StateNotice): MergeMessageNode {
  return {
    kind: "message",
    id,
    label: notice.label,
    detail: notice.detail,
    icon: notice.icon,
    iconColor: notice.iconColor,
  };
}

/** The row shown before the first load completes — shared "connecting" copy + spinner. */
export const LOADING_MESSAGE: MergeMessageNode = messageNode("loading", loadingNotice());

// An empty queue is good news, so it keeps its cheerful check-all glyph rather
// than the neutral empty dot — the shared structure, the pane's own emphasis.
const EMPTY_MESSAGE: MergeMessageNode = messageNode(
  "empty",
  emptyNotice("Merge queue is empty", "Nothing is waiting on the refinery right now.", "check-all"),
);

/** Build the informational row shown when the queue could not be loaded. */
export function loadErrorNode(detail: string): MergeMessageNode {
  return messageNode("error", errorNotice("the merge queue", detail));
}

/**
 * Group entries into per-state nodes for the tree. States with no entries are
 * omitted; an entirely empty queue yields a single informational message row.
 */
export function buildQueueTree(entries: readonly MergeQueueEntry[]): MergeQueueNode[] {
  if (entries.length === 0) return [EMPTY_MESSAGE];

  const byState = new Map<MergeState, MergeEntryNode[]>();
  for (const entry of entries) {
    const node: MergeEntryNode = { kind: "entry", id: `${entry.city}/${entry.beadId}`, entry };
    const list = byState.get(entry.state);
    if (list) list.push(node);
    else byState.set(entry.state, [node]);
  }

  return [...byState.keys()]
    .sort((a, b) => STATE_RANK[a] - STATE_RANK[b])
    .map((state) => {
      const children = byState.get(state) ?? [];
      const group: MergeGroupNode = {
        kind: "group",
        id: `group:${state}`,
        state,
        label: stateLabel(state),
        count: children.length,
        children,
      };
      return group;
    });
}
