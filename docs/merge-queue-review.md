# Merge Queue Review

> Status: **BUILT** (`src/mergeQueue/`, `src/views/mergeQueue.ts`). Implements
> cockpit-21l.2. Builds on the feature registry (cockpit-1ll.15,
> `src/features/`), the beads repository (cockpit-1ll.7, `src/beads/`), and the
> worktree-diff core (cockpit-1ll, `src/code/`).

An editor-side view of the refinery merge queue: the beads a polecat has handed
off, each with its branch, PR and an in-editor diff, plus a one-click path to
approve and merge — so the **bead → polecat → merge** loop closes without leaving
the editor.

## Why this exists

PRD-adjacent expansion (epic cockpit-21l): *"Surface refinery PRs with their diff
and a one-click approve/merge."* The operator already drives work from the
Beads explorer; once a polecat finishes, the work sits in the refinery's queue
waiting to land. This pane brings that queue — and the review it needs — into the
editor, next to the code.

## What it reads

There is **no `/v0` merge-queue endpoint**. The queue is *derived* from beads
(the same `GET /v0/cities` + `/v0/city/{city}/beads` the explorer already loads),
reading the handoff metadata the polecat and refinery write per the Work Bead
Metadata Contract:

| Field | Set by | Meaning here |
|-------|--------|--------------|
| `assignee` (`*/gastown.refinery`) | polecat (submit) | The bead is in the refinery's queue → **Awaiting merge** |
| `rejection_reason` | refinery (on reject) | Kicked back for rework → **Needs rework** |
| `merge_result = merged` / `merged_sha` | refinery (on merge) | Landed → **Recently merged** |
| `branch` / `target` | polecat | The range to review (`target...HEAD`) |
| `work_dir` | polecat (branch-setup) | The worktree the diff is computed in |
| `pr_url` / `existing_pr` | refinery / caller | The pull request, when the rig has a remote |

The derivation, ordering and formatting live in the `vscode`-free
`src/mergeQueue/` core (Seam 1, unit-tested against bead fixtures);
`src/views/mergeQueue.ts` is the thin VS Code glue.

## Lifecycle states

Each entry is placed by precedence — a landed merge is history regardless of who
holds the bead now; otherwise a bead held by the refinery is awaiting; otherwise
a recorded rejection means rework. Ordinary in-flight polecat work (no handoff,
no rejection, not merged) never enters the queue.

- **Awaiting merge** — handed to the refinery, waiting to land.
- **Needs rework** — the refinery rejected it; the reason rides along in the
  tooltip. A re-submitted bead (back with the refinery) drops the stale reason.
- **Recently merged** — shown only with the **Toggle Recently Merged** action,
  since merged beads are closed (loaded only on demand).

## Actions

- **Review Changes** (default click / inline) — opens the branch's diff
  (`target...HEAD`, the set a PR shows) as a **read-only** document. The only git
  run is `git diff`; an agent worktree is never edited from the Cockpit. Falls
  back to the working-tree diff when the target ref is absent, and to the PR when
  no worktree is recorded.
- **Approve & Merge** (inline) — for a rig that records a `pr_url`, opens the
  pull request (where the merge button lives). The Cockpit is a pure `/v0`
  client and never performs the merge itself; for rigs whose refinery merges
  locally, this explains that and points back to the diff.
- **Open Pull Request** — jumps straight to the PR for entries that have one.
- **Copy Branch Name** — for a manual `git` follow-up.
- **Refresh** / **Toggle Recently Merged** (view title) — reload, and show or
  hide the merged history.

## Design notes

- **No invented backend.** Nothing here pretends a merge API exists; the queue is
  a read-only projection of beads, and the merge stays the refinery's (or the
  PR's) job.
- **Self-contained.** The feature touches only its own module plus the three
  append-only registry seams (`FEATURES`, `FEATURE_ORDER`, the view-order
  assertion). It reuses `src/code` for the diff range/plumbing rather than
  editing the codeNav feature.
