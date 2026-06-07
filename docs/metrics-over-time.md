# Metrics over time

> Status: **BUILT** (`src/metrics/`, `src/views/metrics.ts`). Implements
> cockpit-3x7. Builds on the feature registry (cockpit-1ll.15, `src/features/`),
> the typed `/v0` client (cockpit-1ll.1, `src/api/`), and the cross-pane state
> vocabulary (cockpit-1ll.19, `src/ui/view-state.ts`).

A VS Code tree view — **Metrics** — that reports three bead-lifecycle metrics over
a **selectable window** (24 hours / 7 days / 30 days), broken down **per rig** and
**per agent**:

- **Throughput** — issues closed, with a per-bucket sparkline of the trend.
- **Cycle time** — open→closed duration (median / p90 / max).
- **Refinery reject rate** — rejected submissions over total submissions.

It is a windowed **snapshot**, not a live stream: it reads history on connect /
refresh / window-change and derives the model in one pass. Toggling rig⇄agent
re-renders from the already-derived model without re-fetching.

## What it reads

Everything comes from existing `/v0` endpoints — no `/v0` change (cockpit-3x7):

| Pane content | Source | Notes |
|--------------|--------|-------|
| The set of rigs (for bead→rig attribution) | `GET /v0/city/{city}/rigs` | rig `prefix` → rig `name` (e.g. `cockpit` → `gascity-cockpit`) |
| Bead lifecycle history | `GET /v0/city/{city}/events?since=<window>` | fanned out across `GET /v0/cities` |

The window maps directly onto the `since` filter as a Go duration (`7d` → `168h`,
since Go durations have no day unit). `bead.closed` envelopes give throughput and
cycle time (`event.ts − bead.created_at`); a `bead.updated` envelope whose bead
carries a non-empty refinery `rejection_reason` is a reject.

## Attribution

- **Per rig — exact.** A bead's rig is its id prefix looked up in the live rig
  index (`cockpit-3x7` → `gascity-cockpit`). Falls back to the actor's `<rig>/`
  scope, then `(unscoped)`. This is independent of who performed the close, so the
  per-rig breakdown is precise.
- **Per agent — best effort.** Resolved from `metadata["gc.session_name"]` (the
  recorded implementer), else the bead `assignee`, else the lifecycle `actor`.
  Because the refinery/controller perform most closes and rejects, a system actor
  can stand in when no implementer was recorded — see the gaps below.

Only countable work beads are tallied: ephemeral molecule tracking beads
(`*-wisp-*`, the bulk of event-log churn) and container types (epics, convoys) are
excluded.

## Honest by construction (graceful degradation)

The pane never overclaims:

- **Empty / sparse** windows render the shared loading→empty→error edges
  (`src/ui/view-state.ts`); a window with no closed work shows a clear "No issues
  closed in this window" rather than zeros pretending to be data. Reject rate is
  `—` when there were no submissions.
- **Capped coverage.** `/v0` caps an event page (~1000) and the city endpoint's
  `type` filter is not honored, so events are filtered client-side and a full page
  means older in-window events are missing. That case surfaces a **partial-window**
  notice and the totals are presented as a floor, never a complete count.
- **No charting runtime.** A tree view has no canvas, so the time series is a
  Unicode sparkline in the row description — the Cockpit's "honest text rendering"
  convention.

## The upstream gaps → cockpit-e56

The Cockpit is a pure `/v0` client; these limits are filed in **cockpit-e56**
(`discovered-from` cockpit-3x7) and the surface tightens with zero cockpit changes
once `/v0` closes them:

1. No first-class `closed_at` on beads (cycle time leans on the event `ts`).
2. `ephemeral` absent on event payloads (forces the `*-wisp-*` id heuristic).
3. The city events `type` filter is ignored (forces client-side filtering).
4. Event pages cap with no usable `next_cursor` (forces the partial-window floor).
5. No per-implementer identity on close events (per-agent leans on
   `gc.session_name`/assignee/actor).

## Architecture

Per the PRD Testing Decisions, all logic lives behind a provider-agnostic,
`vscode`-free **Seam 1** core; the editor binding is a thin, untested adapter. It
mirrors the cost & tier telemetry feature.

```
src/metrics/            Seam 1 — NO `vscode` imports (unit-tested under vitest)
  types.ts              MetricEvent, MetricWindow, GroupMetrics, MetricsModel, MetricsState, …
  events.ts             normalizeEvent() + rig/agent attribution + the work-bead filter
  derive.ts             deriveMetrics() — windowing, bucketed throughput, cycle percentiles, reject rate
  format.ts             sparkline + duration/percent/count formatting + row descriptions
  load.ts               loadMetrics() — cities fan-out → per-city rigs+events → normalize → derive
  store.ts              MetricsStore — observable state (phase, window, group-by, model)
  index.ts              public barrel
src/views/metrics.ts    thin VS Code adapter: the "Metrics" TreeDataProvider + title commands
src/features/metrics.feature.ts        self-registers; loads only against a healthy supervisor
src/features/metrics.contributes.json  the view + refresh / window / group-by commands
```

Notes for contributors:

- **Snapshot, not stream.** Unlike telemetry, this pane does not hold an SSE
  subscription — "metrics over a window" is inherently a windowed read with a
  refresh. A `generation` token in the feature discards a superseded load so a
  stale window can't overwrite a newer one.
- **Re-derive, don't re-fetch.** `deriveMetrics` filters by window from the same
  event list, so a window change re-fetches but a group-by toggle does not (the
  model already carries both `byRig` and `byAgent`).
- **Tolerant fan-out.** A per-city rig/event failure degrades to a partial result;
  only an unreachable `/v0/cities` is a hard error.
