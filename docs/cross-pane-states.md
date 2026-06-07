# Cross-Pane Empty / Loading / Error / Reconnecting States

> Status: **BUILT** (`src/ui/view-state.ts` + `src/ui/pane-state.ts`). Implements
> cockpit-1ll.19 (the loading/empty/error trio — the residual from the .13 polish
> decomposition) and **cockpit-n5p**, which adds the fourth state (**reconnecting**)
> and the state machine that picks between all four from a pane's data and the live
> supervisor connection, then adopts it across every data-bearing pane (Fleet,
> Event Feed, Beads, merge queue, cost-tier telemetry, and the docked Mayor chat).
> Builds on the shared city presentation helpers (cockpit-1ll.16,
> `src/cities/presentation.ts`) and the connection state machine
> (`src/discovery/connection.ts`, docs/api-discovery-and-resilience.md).

Every data-bearing pane goes through four states before (or instead of) showing
rows: **loading** (the first fetch is in flight, or the supervisor link is still
coming up), **empty** (the fetch returned nothing), **error** (the fetch failed
while the supervisor was reachable), and **reconnecting** (the supervisor link
dropped — `gc stop`, a restart, a city stopping — and the Cockpit is backing off
and re-discovering). This is the one source of truth for how those four states
look and read, so two panes in the same state are indistinguishable, and the
ordering between them is decided once (see [The state machine](#the-state-machine))
rather than re-derived by each pane.

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

- **`StateTone`** — `"loading" | "empty" | "error" | "reconnecting"`.
- **`STATE_LOOK`** — the codicon (and `ThemeColor` id) each tone wears: the
  spinner for loading, the theme error glyph/colour for error, a neutral dot for
  empty, and — for reconnecting — the `sync` glyph spinning in the theme's
  *warning* colour, so a lost link reads as "transient, being worked on" rather
  than the neutral first-load spinner or the hard error red. The error look
  matches the existing Fleet status icons in `status/views.ts`, so a state row and
  a city row read in the same visual key.
- **`loadingNotice()` / `emptyNotice(label, detail?, icon?)` / `errorNotice(resource, detail?)` / `reconnectingNotice(detail?)`**
  — factories that bake consistent copy. Loading defaults to the shared
  `CONNECTING` string; error is always `Couldn't load <resource>.` with the raw
  cause folded into the detail line; empty takes the pane's own copy (an empty
  merge queue keeps its cheerful `check-all`); reconnecting is the shared
  `RECONNECTING` string with the drop's cause (the failed probe + backoff) in the
  detail.

Each factory returns a **`StateNotice`** (`{ tone, label, detail?, icon, iconColor? }`).
The thin tree glue spreads it onto its own message/notice node and renders the
icon with its colour — so the error red now shows on every pane, and a dropped
supervisor degrades to the same clear, consistently-worded *reconnecting* notice
everywhere (its cause rides in the detail) and recovers on its own when the link
returns.

## The state machine

`view-state.ts` is the *vocabulary*; `src/ui/pane-state.ts` is the *grammar* that
decides which tone a pane is in. A pane no longer hand-rolls an `if (error) … else
if (loading) …` ladder — it hands `resolvePaneState()` what it has and what the
link is doing, and gets back one decision:

- **`Connectivity`** — the seven-state connection lifecycle
  (`discovery/connection.ts`) projected onto the three values a pane reacts to:
  `starting` (idle / discovering / connecting / the up-but-not-ready `degraded`),
  `live` (`connected`), and `lost` (`reconnecting` / `unavailable` — both "the
  link is down, hold on"). `connectivityOf(state)` is the projection.
- **`resolvePaneState({ connectivity, loading, hasContent, error, resource, empty })`**
  applies one ordering: a **lost** link wins (it surfaces as reconnecting,
  subsuming any pane-local fetch error — that error is just the drop's symptom);
  then a **starting** link shows the connecting row; then, **live**, the pane's own
  data decides (error → first-load → has-rows → empty). It returns either
  `{ kind: "ready" }` (render your content) or `{ kind: "notice"; notice; overlay }`.
  `overlay` marks the one case where the notice rides *with* retained content — a
  lost link while the pane still holds (now-stale) rows — so the operator keeps
  reading them under a reconnecting banner instead of the pane blanking on every
  blip. `paneNotice()` is the flattened `StateNotice | null` form for panes that
  always replace their whole body.

This is what makes "API-down / city-stopped degrade gracefully and recover on
reconnect" uniform: the drop flips `connectivity` to `lost` for every pane at
once, each shows the same reconnecting row, and the flip back to `live` (or a
re-discovered endpoint) clears them all without any pane-specific recovery code.

## Adopting it

A pane keeps a **store-level connectivity flag** (the offline signal the original
trio lacked): its feature forwards `setConnectivity(connectivityOf(status.state))`
on every `onStatusChange`, idempotently, so a routine health poll that doesn't
move connectivity is silent. The pane's `TreeDataProvider` then calls
`resolvePaneState(...)` in its "what do I render" path and maps the returned
`StateNotice` onto whatever message-node shape it walks — see
`src/views/beadsExplorer.ts` and `src/views/mergeQueue.ts` (`stateRow`),
`src/status/views.ts` (the Fleet/Event `noticeNode`), and `src/views/telemetry.ts`
(`stateNoticeNode`). Render the icon with
`new vscode.ThemeIcon(node.icon, node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined)`.
The adopting panes: **Fleet**, **Event Feed**, **Beads**, **merge queue**, and
**cost-tier telemetry** (the trees), plus the docked **Mayor chat** webview (which
posts the notice as a `ChatNotice`, its tone now carrying `reconnecting`).

This vocabulary is for the four connection/data states. A pane whose informational
rows carry a *severity* — the telemetry pane's "not yet instrumented" / "older
scopes dropped" advisories (`src/views/telemetry.ts`), which render through the
status `statusIcon(severity)` ladder — deliberately keeps that richer model
alongside the four tones (its *empty* row goes through `resolvePaneState`; its
*advisories* do not). The bead → worktree → diff navigation (`src/views/codeNav.ts`)
has no persistent pane of its own — it is a command-driven, read-only diff viewer —
so it has no empty/loading/error/reconnecting surface to unify.

## Webviews

The **docked Mayor chat** now borrows the vocabulary (cockpit-n5p): when it has no
live session to project it posts a `ChatNotice` built from `paneNotice(...)`, so a
dropped supervisor reads as *reconnecting* — recovering on its own when the link
returns — rather than the hard "Supervisor API unavailable" error it used to show.
Its `tone` therefore mirrors the full four-tone `StateTone`.

The **dashboard** and **time-travel** webviews still own a single, self-contained
state surface — a connection pill, a "configure me" card, a "waiting for events"
timeline — that is already internally consistent and context-appropriate, so they
keep their bespoke copy rather than borrowing a tree row's vocabulary. The original
gap (the time-travel panel has no *offline* indicator while you scrub recorded
history) is now unblocked: the store-level connectivity flag this bead introduces
is exactly the supervisor-reachability signal it needed. Wiring it into the
time-travel panel — together with a distinct dimmed-`circle-slash` "offline" tone,
which the Fleet supervisor row already uses for `health: null` — is a small
follow-up rather than a missing primitive.
