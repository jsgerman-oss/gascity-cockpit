# Event Time-Travel

> Status: **BUILT** (`src/timetravel/`, `src/views/timeTravel.ts`). Implements
> cockpit-21l.6 — a power-user surface of the expansion epic (cockpit-21l). Builds
> on the live status feature's `vscode`-free event core (cockpit-1ll.6,
> `src/status/`): the same `SupervisorEventStream`, `parseFleetEvent`, and feed
> presentation (`eventLabel` / `eventDescription` / `eventStatusKind`).

Scrub and replay the supervisor `/v0/events/stream` feed to reconstruct exactly
what the agents did, for debugging and audit. Run **`GasCity Cockpit: Event
Time-Travel…`** (or the `history` button on the **Event Feed** view title) to open
a scrubber panel over everything the Cockpit has recorded this session.

## Why this exists

The live **Event Feed** is a newest-first ticker — great for *what just happened*,
useless for *what happened five minutes ago, in order*. Reconstructing an incident
means reading a fast-scrolling list backwards. Time-travel turns the same feed into
a **timeline you can move through**: drag the playhead to any point, step event by
event, or press play to replay the run forward at speed. Each event keeps the feed's
own headline, description, and severity tint, so the replay reads exactly like the
feed it reconstructs.

## Using it

The panel records in the background from the moment the Cockpit connects, so by the
time you open it there is history to scrub.

| Control | Does |
|---------|------|
| **Scrubber** (slider) | Move the playhead to any point; events past it dim to a "not yet" ghost |
| **⏮ / ⏭** | Jump to the start / to the live edge |
| **◀ / ▶** | Step back / forward one event |
| **Play / Pause** | Replay forward from the playhead; from the live edge it replays from the start |
| **Speed** | 0.5× / 1× / 2× / 4× replay cadence |
| **Copy event** | Copy the current event (seq, time, type, city, actor, subject, message) to the clipboard |
| **Save scenario** | Save the whole recording as a replay-to-regression scenario fixture (see below) |

The **live** badge shows when the playhead is at the latest event; while it is, new
events follow automatically. Scrub back and the panel holds your position while the
recording keeps growing behind the live edge. A detected supervisor restart clears
the recording — the supervisor's sequence counter resets, so the two epochs can't
share a timeline.

## Architecture

Following the PRD Testing Decisions, the behaviour lives behind a provider-agnostic,
`vscode`-free **Seam 1** core (the recorder + projection) and a pure **Seam 2** HTML
builder; the editor binding is a thin, untested adapter.

```
src/timetravel/
  types.ts      TimelineRow / TimelineBounds / TimelineSnapshot, EventSeverity
  recorder.ts   EventTimeline — chronological, de-duped, capped recording + onDidRecord
  view.ts       buildTimelineView() — events → serializable rows (reuses feed presentation)
  webview.ts    renderTimeTravelHtml() — the CSP-locked scrubber document (pure string)
  scenario.ts   capture/run/serialize replay-to-regression scenarios (cockpit-6x0)
  scenarios/    committed *.scenario.json fixtures + the loader barrel
  index.ts      barrel
src/views/
  timeTravel.ts   the WebviewPanel glue: posts rows in, forwards live appends, copy, save
```

`EventTimeline` is the audit recorder: it keeps events in **chronological** order
(oldest first), de-dupes by the monotonic supervisor `seq` so a reconnect's
`Last-Event-ID` replay can't double-count, and caps at `TIMELINE_CAP` (1000) so a
long-running rig stays flat in memory. This is deliberately *not* the live feed's
newest-first ring (`FleetStatusStore`, cap 250) — a replay needs order and depth the
ticker doesn't.

All the scrub/replay interaction (slider, play loop, stepping, highlight) runs in
the webview against rows the host posts in; the host stays a courier. Every
server-provided field is rendered via `textContent`, never `innerHTML`, and the
document is locked to a per-load script nonce under `default-src 'none'`.

### Why a second event stream

The feature runs its **own** `SupervisorEventStream`, separate from the live status
feature's, wired to the connection through `host.onStatusChange` exactly as
`status.feature.ts` drives its feed. Features are isolated — the host deliberately
does not share the event stream — so the modest cost of a second localhost SSE
connection buys a purpose-built recorder (chronological, larger-capped) without
reaching into another feature's private store. The stream tears down on disconnect
and reconnects on a restart or endpoint change; `liveKey` dedupes the connected
endpoint so routine health polls don't churn it.

## Replay-to-regression scenarios

A recorded run is also a test fixture. **Save scenario** (cockpit-6x0) freezes the
current recording — the raw event sequence *and* the exact derived state the
recorder produced from it — into a JSON file under `src/timetravel/scenarios/`. A
runner (`runScenario`) replays the events back through a fresh `EventTimeline` and
asserts the derived state has not drifted, turning a captured incident into a
regression test for the recorder (de-dup, cap eviction) and the feed projection.

Capture and replay share one code path — `captureScenario` derives the expected
snapshot, `runScenario` re-derives and compares — so a freshly captured scenario
always passes. The regression value comes from the committed `expected` being
*frozen*: if the recorder or projection later changes the state a real run
derives, the runner re-derives a different snapshot and the frozen expectation no
longer matches. That drift is caught by `scenario.regression.test.ts`, which
replays every committed fixture.

Three scenarios ship today, each guarding a distinct recorder behaviour:
`incident-replay` (a crash→escalation→drain→restart run — ordering and the
ok/warn/error severity tints), `reconnect-dedup` (a reconnect re-delivering the
cursor-boundary event — monotonic-seq de-dup), and `ring-overflow` (more events
than the cap — eviction of the oldest). To add one: click **Save scenario**, drop
the JSON in `src/timetravel/scenarios/`, and append it to that folder's `index.ts`
(it is validated on load).

## Registration

Per the [feature-registry contract](contributing-features.md), the feature is a
self-contained module — `src/features/timeTravel.feature.ts` owns the recorder and
its stream and registers the command via `src/views/timeTravel.ts`,
`src/features/timeTravel.contributes.json` owns its one command + the Event Feed
title-bar button, and the only shared touch-point is the append-only entry in
`src/features/index.ts`. It edits neither `extension.ts` nor the `package.json`
`contributes` block by hand.
