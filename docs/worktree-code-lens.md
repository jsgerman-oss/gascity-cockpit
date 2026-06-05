# Worktree Code Lens

> Status: **BUILT** (`src/code/lens.ts`, `src/views/worktreeLens.ts`). Implements
> cockpit-21l.8. Builds on the feature registry (cockpit-1ll.15,
> `src/features/`), the beads repository (cockpit-1ll.7, `src/beads/`), and the
> worktree-diff core (cockpit-1ll, `src/code/worktree.ts`).

Annotate a file with the in-flight beads/polecats whose worktrees are editing it
**right now** — a CodeLens at the top of the file and a badge in the Explorer and
editor tabs — so an operator sees a collision before two agents stomp the same
file.

## Why this exists

PRD-adjacent expansion (epic cockpit-21l). The PRD's framing of the operator's
pain is *"the code my agents are working on lives in polecat worktrees I have to
find."* Code navigation (cockpit-1ll, stories 27–29) answers one direction:
**bead → worktree → diff**. This lens answers the **inverse** — *file → the beads
touching it* — which is the question you have when you are already looking at a
file and want to know who else is in it.

## How it works

The feature is split along the project's standard seam.

- **Domain core — `src/code/lens.ts` (`vscode`-free, unit-tested).** The inverse
  of `worktree.ts`. It turns a set of worktree footprints into a
  `WorktreeActivityIndex` keyed by repo-relative path, so a per-file lookup is
  O(1), and formats the annotations (`touchSummary`, `touchDetail`,
  `touchDecoration`). `buildActivity` reuses `resolveWorktree` to read a bead's
  `work_dir`/`branch`/`target` metadata and de-duplicates the changed-file list;
  `buildIndex` can exclude the operator's own checkout so you are never flagged as
  colliding with yourself.

- **Editor glue — `src/views/worktreeLens.ts` (thin, untested).** On a timer (and
  on every (re)connect), it loads beads across all cities, keeps the
  `in_progress` ones that have a worktree, and runs **read-only**
  `git diff --name-status` in each — the committed PR range (`target...HEAD`)
  unioned with the uncommitted working tree (`HEAD`). It then registers a
  `CodeLensProvider` and a `FileDecorationProvider` that read the index. As with
  code navigation, no agent worktree is ever edited.

Clicking the lens lists the worktrees editing the file and opens the chosen one's
read-only diff (reusing code navigation's `Show Worktree Diff`).

### Same-repo scoping

Diff paths are repo-relative, so an unrelated rig with its own `src/index.ts`
could look like a collision. The glue scopes matches to worktrees that share the
open workspace's git repository (equal `git rev-parse --git-common-dir`), and
fails open when the common dir cannot be determined. The bead's rig is shown in
the lens detail either way.

## Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `gascityCockpit.worktreeLens.enabled` | `true` | Master switch for the lens and the Explorer badge. |
| `gascityCockpit.worktreeLens.refreshIntervalSeconds` | `30` (min `5`) | How often the fleet's worktrees are re-scanned. |

Commands: **Refresh Worktree Lens** (palette) forces a re-scan; **Show Worktrees
Editing This File** is the lens's click action.

## Limitations

- "Touching right now" is the union of committed and tracked-uncommitted changes;
  brand-new **untracked** files in a worktree are not yet reported.
- Matching is by repo-relative path within the same repository; it assumes the
  open workspace folder is the repository root (the usual single-rig checkout).
