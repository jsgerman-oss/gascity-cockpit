# Fleet Command Palette

> Status: **BUILT** (`src/fleet/`, `src/views/fleetPalette.ts`). Implements
> cockpit-21l.1 — the first power-user surface of the expansion epic
> (cockpit-21l). Builds on the Beads explorer's `vscode`-free core
> (cockpit-1ll.5, `src/beads/`) and the multi-city repository over the typed /v0
> client (`BeadsRepository.loadExplorer`).

A natural-language query bar for the whole fleet. Run **`GasCity Cockpit: Query
Fleet…`** from the command palette, type a plain-language request — *"show
failing beads in cockpit"*, *"unassigned p0 features across all cities"* — and
the Cockpit resolves it into a structured query, runs it across every city, and
lists the matches. Pick one to open its detail.

## Why this exists

The Beads explorer (cockpit-1ll.5) is great for *browsing* by city/group, but
answering a pointed question — "what's failing in cockpit right now?" — means
clicking through filters. This is the omnibox: one line of plain language to the
same answer, fleet-wide. It is deliberately a **deterministic** resolver, not a
model call: an NL bar is only trustworthy if its interpretation is provable, so
the grammar is fixed, documented, echoed back ("Interpreted as…"), and unit
tested.

## The grammar it understands

Each recognised phrase folds into the explorer's own
[`BeadFilters`](../src/beads/types.ts) predicate plus a city scope. Anything the
parser doesn't recognise is reported back as "didn't understand: …".

| You type | It resolves to |
|----------|----------------|
| `failing`, `failed`, `stuck`, `broken`, `attention` | status ∈ {blocked, escalated} |
| `blocked` / `ready` / `escalated` / `deferred` | that display status |
| `in progress`, `active`, `wip`, `running` | status = in_progress |
| `closed`, `done`, `finished`, `merged`, `resolved` | status = closed (reveals closed) |
| `open` (and `unfinished`, `outstanding`, …) | no-op — closed are hidden by default |
| `bugs` / `features` / `tasks` / `epics` / `chores` | `issue_type` filter |
| `p0`–`p3`, `critical`/`urgent`, `high/normal/low priority` | numeric priority |
| `unassigned`, `assigned to <agent>` | assignee filter |
| `"quoted text"`, `matching <word>` | id/title text search |
| `top N`, `first N`, `limit N`, `N beads` | result cap |
| `in <city>`, `for <city>` | scope to one city (partial name matches: `cockpit` → `gascity-cockpit`) |
| `across all cities`, `everywhere`, `fleet-wide` | the default — every city |

Multiple status words union (`ready or blocked` → both); a bare query defaults to
open beads across all cities.

## Architecture

Following the PRD Testing Decisions, the logic lives behind a provider-agnostic,
`vscode`-free **Seam 1** core; the editor binding is a thin, untested adapter.

```
src/fleet/
  types.ts     FleetQuery (BeadFilters + cityScope + limit), ParsedFleetQuery
  parse.ts     parseFleetQuery() — the dictionary-driven NL grammar + summary
  execute.ts   runFleetQuery() — scope resolution, then the explorer's predicate
  index.ts     barrel
src/views/
  fleetPalette.ts   the QuickPick omnibox (re-parses on every keystroke)
```

`parse → run` is a clean split: the parser is pure string→query; the executor
resolves the city scope against the **live** city list (so `cockpit` only has to
match whatever the supervisor currently serves) and then defers every selection
to the Beads explorer's tested core — `filterRecords`, `sortRecords`,
`deriveDisplayStatus`. The palette and the explorer can never disagree about what
"blocked" means, because there is one implementation.

The glue loads one multi-city snapshot (`loadExplorer({ includeClosed: true })`)
and filters it in memory on each keystroke; `alwaysShow` keeps every computed
result visible rather than letting VS Code filter the list by the raw query text.
Selecting a row reuses the explorer's `gascityCockpit.beads.openDetail` command
instead of duplicating the detail renderer.

## Registration

Per the [feature-registry contract](contributing-features.md), the feature is a
self-contained module — `src/features/fleetQuery.feature.ts` registers the
command against the host, `src/features/fleetQuery.contributes.json` owns its one
palette command, and the only shared touch-point is the append-only entry in
`src/features/index.ts`. It edits neither `extension.ts` nor the `package.json`
`contributes` block by hand.
