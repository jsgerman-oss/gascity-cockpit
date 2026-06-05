# Cross-Pane Empty / Loading / Error States

> Status: **BUILT** (`src/ui/view-state.ts`). Implements cockpit-1ll.19 — the
> residual from the .13 polish decomposition (cockpit-1ll.13 shipped a11y,
> theming, and the multi-city chat picker, but not a consistent treatment of the
> "no content yet" states). Builds on the shared city presentation helpers
> (cockpit-1ll.16, `src/cities/presentation.ts`).

Every data-bearing tree pane goes through three states before it has rows to show:
**loading** (the first fetch is in flight), **empty** (the fetch returned
nothing), and **error** (the fetch failed — including a dropped supervisor
connection). This is the one source of truth for how those three states look and
read, so two panes in the same state are indistinguishable.

## Why this exists

The .13 pass left each pane inventing its own "no content" rows:

| Pane | Loading | Empty | Error |
|------|---------|-------|-------|
| Beads explorer | `loading~spin` "Connecting to supervisor…" | (no-cities only) | `error` **"Cannot load beads"** |
| Fleet | `loading~spin` "Connecting to supervisor…" | "No cities registered" | **no icon** (rendered a neutral `info` dot) + raw API error as the label |
| Merge queue | `loading~spin` "Connecting to supervisor…" | `check-all` "Merge queue is empty" | `error` **"Cannot load merge queue"** |

The loading copy already matched (it was shared via `CITY_PLACEHOLDER`), but the
error rows diverged three ways — two different "Cannot load X" strings and, on the
Fleet tree, an error that wore the *wrong icon* because no icon was passed. A
reader could not tell a failed Fleet from an empty one.

## The model

`src/ui/view-state.ts` is `vscode`-free (Seam 1) and exposes a small vocabulary:

- **`StateTone`** — `"loading" | "empty" | "error"`.
- **`STATE_LOOK`** — the codicon (and `ThemeColor` id) each tone wears: the
  spinner for loading, the theme error glyph/colour for error, a neutral dot for
  empty. The error look matches the existing Fleet status icons in
  `status/views.ts`, so a state row and a city row read in the same visual key.
- **`loadingNotice()` / `emptyNotice(label, detail?, icon?)` / `errorNotice(resource, detail?)`**
  — factories that bake consistent copy. Loading defaults to the shared
  `CONNECTING` string; error is always `Couldn't load <resource>.` with the raw
  cause folded into the detail line; empty takes the pane's own copy (an empty
  merge queue keeps its cheerful `check-all`).

Each factory returns a **`StateNotice`** (`{ tone, label, detail?, icon, iconColor? }`).
The thin tree glue spreads it onto its own message/notice node and renders the
icon with its colour — so the error red now shows on every pane, and an
unreachable supervisor degrades to the same clear, consistently-worded notice
everywhere (its cause rides in the detail).

## Adopting it

A new tree pane builds its three rows from the factories and maps the result onto
whatever message-node shape its `TreeDataProvider` walks — see
`src/views/beadsExplorer.ts` (`noticeNode`), `src/mergeQueue/format.ts`
(`messageNode`), and `src/status/views.ts` (`noticeNode`). Render the icon with
`new vscode.ThemeIcon(node.icon, node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined)`.

This vocabulary is for the loading → empty → error trio specifically. A pane whose
informational rows carry a *severity* — the telemetry pane's "not yet
instrumented" / "older scopes dropped" advisories (`src/views/telemetry.ts`), which
render through the status `statusIcon(severity)` ladder — deliberately keeps that
richer model rather than flattening to these three tones.

## Webviews

The chat, dashboard, and time-travel **webviews** were audited too. Each owns a
single, self-contained state surface — a connection pill, a "configure me" card,
a "waiting for events" timeline — that is already internally consistent and
context-appropriate, so they keep their bespoke copy rather than borrowing a tree
row's vocabulary. The one genuine gap (the time-travel panel has no *offline*
indicator while you scrub recorded history) needs a supervisor-reachability
signal the panel does not yet receive; surfacing it — together with a distinct
dimmed-`circle-slash` "offline" tone, which the Fleet supervisor row already uses
for `health: null` — is left as a follow-up that wants a store-level offline flag.
