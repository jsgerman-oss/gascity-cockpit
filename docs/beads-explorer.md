# Beads explorer

The Beads explorer (epic task `cockpit-1ll.5`, PRD user stories 7–11) is a
multi-city tree of beads in the editor: open / ready / in-progress / closed with
rich status, filter and group by status / rig / assignee / type / priority, a
bead detail view, and a dependency-graph visualization.

It follows the same seam discipline as the rest of the Cockpit: a
provider-agnostic domain layer (`src/beads/`, no `vscode` import, unit-tested
against a mock `/v0`) under a thin VS Code surface (`src/views/beadsExplorer.ts`,
kept out of heavy testing).

## /v0 endpoints used

All bead data comes from the existing per-city endpoints — the Cockpit adds no
backend of its own:

| Endpoint | Used for |
| --- | --- |
| `GET /v0/cities` | enumerate cities for the top tree tier (multi-city) |
| `GET /v0/city/{city}/beads` | a city's beads (`all=true` includes closed) |
| `GET /v0/city/{city}/beads/ready` | the ready-id set, intersected for readiness |
| `GET /v0/city/{city}/bead/{id}` | full detail for one bead |
| `GET /v0/city/{city}/beads/graph/{rootID}` | a bead's dependency graph |

`BeadsRepository.loadExplorer()` lists cities and fans out across the **running**
ones in parallel (`Promise.allSettled`). A failure in one city is captured as an
error row on that city rather than blanking the whole tree; stopped cities show a
"city stopped" placeholder. Readiness is an enrichment: if `/beads/ready` is
unavailable the records carry `ready: null` and open beads stay "open" rather than
being mislabeled "blocked".

## Rich status

The raw bead `status` is coarse (`open` / `in_progress` / `closed` / …).
`deriveDisplayStatus` refines it for display and ordering:

- `closed`, `in_progress`, `escalated` come straight from the raw status.
- an **open** bead becomes `ready` (in the ready set), `blocked` (not ready),
  `deferred` (future `defer_until`), or plain `open` (readiness unknown).
- any unrecognized raw status passes through lower-cased — nothing is dropped.

Statuses sort most-actionable first: in_progress → ready → blocked → open →
deferred → escalated → closed.

## Rig heuristic

/v0 beads carry no explicit rig field, so `beadRig` reads the dispatcher's
routing metadata, in order: `metadata.rig`, then the rig segment of
`gc.routed_to` (`"rig/role"`), then of a `"rig/agent"` assignee, falling back to
`(unrouted)`. This keeps "group by rig" working without inventing data.

## Filter, group, tree

`filterRecords` applies an AND of the active predicates (text over id/title,
display status, rig, assignee, type, priority, plus an include-closed toggle).
`groupRecords` partitions a city's filtered beads by the chosen dimension into
ordered, counted groups, and `buildBeadTree` assembles the `city → group → bead`
structure the tree provider walks. Empty / stopped / errored states collapse to a
single explanatory row so the view is never blank-and-confusing.

Group-by and include-closed are persisted in `globalState`; ad-hoc filters are
session-scoped. The view title shows the active grouping and whether a filter is
applied.

## Detail and graph

- **Detail** (`formatBeadDetailMarkdown`) renders the bead as read-only Markdown
  — heading, rich-status line, a field table, description, typed dependency list,
  and a metadata table — shown via a `gascity-bead:` `TextDocumentContentProvider`
  in the Markdown preview. Only fields the /v0 `Bead` contract exposes are shown;
  comments and edit history are not part of that contract and are noted, not
  faked.
- **Graph** (`buildDependencyGraph` → `layerGraph` → `renderGraphSvg`) turns a
  `/beads/graph` response into a longest-path layered DAG and renders it as a
  self-contained SVG whose colors reference VS Code theme variables. It is shown
  in a CSP-locked webview; clicking a node opens that bead's detail. A Mermaid
  serialization (`renderGraphMermaid`) is available as an alternative. Dependency
  cycles are parked past the acyclic frontier so layout always terminates.

## Known limitations

- Beads are fetched a page at a time; `ListBodyBead.partial` is surfaced as a
  `+` on the city count rather than auto-paginated. Cursor pagination can be added
  to the repository without touching the filter/group/tree layer.
- Updates are pull-based: the explorer reloads on connect, supervisor restart, API
  drop, and the manual **Refresh** action. Live SSE bead updates are a follow-on.
