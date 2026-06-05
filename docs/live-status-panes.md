# Live Status Panes

> Status: **BUILT** (`src/status/`). Implements cockpit-1ll.6 and PRD user
> stories 1–4 (live city health, fleet of cities, live event feed, agent/session
> state). Builds directly on the API discovery + resilience contract
> (cockpit-1ll.2, `src/discovery/`) and the typed /v0 client + SSE reader
> (cockpit-1ll.1, `src/api/`).

The first feature surface of the Cockpit: two VS Code tree views that show the
state of your fleet — supervisor health, every registered city, the agents and
sessions inside each running city, and a real-time feed of supervisor events —
and keep themselves current over SSE.

## Why this exists

PRD: *"Live status panes (city health, agents, sessions, event feed) updating in
real time over SSE."* The operator drives the fleet from a terminal today
(`gc`, `gc bd`, the static web dashboard); this brings at-a-glance fleet state
into the editor, where the operator already reads the code.

## What it reads

| Pane content | Endpoint | Schema |
|--------------|----------|--------|
| Supervisor health | `GET /health` | `SupervisorHealthOutputBody` |
| Cities | `GET /v0/cities` | `CityInfo[]` |
| Agents (per running city) | `GET /v0/city/{cityName}/agents` | `AgentResponse[]` |
| Sessions (per running city) | `GET /v0/city/{cityName}/sessions` | `SessionResponse[]` |
| Event feed | `GET /v0/events/stream` (SSE) | `TaggedEventStreamEnvelope` |

The supervisor-tagged stream carries every city's events (each envelope is
tagged with its `city`), so one subscription drives the whole fleet's feed.

## Architecture

Following the PRD Testing Decisions, all the logic lives behind a
provider-agnostic, `vscode`-free **Seam 1** core; the editor binding is a thin
adapter that is intentionally not unit-tested.

```
ConnectionManager (src/discovery)         ← owns reachability (health poll,
        │  onDidChangeStatus                 discovery, restart detection)
        ▼
extension.ts  applyLiveStatus()           ← connect/disconnect the live status
        │                                    as the supervisor comes and goes
        ▼
LiveStatus (live.ts)  ── snapshot ──▶ fetchFleetSnapshot (snapshot.ts) ─▶ typed /v0 client
        │             ── events ────▶ SupervisorEventStream (events.ts) ─▶ openSSE
        ▼
FleetStatusStore (store.ts)               ← single observable model + change signal
        │  onDidChange
        ▼
FleetTreeProvider / EventsTreeProvider (views.ts)   ← thin vscode glue
```

- **`store.ts` — `FleetStatusStore`**: the one observable model the views read.
  Snapshots replace the health/cities/agents/sessions; events append to a bounded
  (newest-first, cap 250) ring buffer; a single `onDidChange` drives re-render.
- **`snapshot.ts` — `fetchFleetSnapshot`**: health + cities, then per-*running*-
  city agents + sessions in parallel. Resilient: any single call failing is
  recorded in `partialErrors` rather than blanking the panes.
- **`events.ts` — `SupervisorEventStream`**: makes the single-shot `openSSE` a
  *durable* subscription — it reconnects with the same `backoffDelay` the health
  manager uses, and threads `Last-Event-ID` so no events are missed across a
  reconnect. `parseFleetEvent` is a pure envelope parser (drops heartbeats /
  comments / malformed payloads).
- **`live.ts` — `LiveStatus`**: the orchestration seam. On `connect()` it takes a
  full snapshot and subscribes to the feed; each status-affecting event appends
  to the feed and schedules a **debounced** re-snapshot (mail events are ignored
  — `affectsStatusPanes`). Stale snapshots are guarded by generation + per-refresh
  tokens so only the newest result is applied.
- **`format.ts`**: pure label / description / severity helpers, so the tree glue
  carries no presentation logic worth testing.
- **`views.ts`**: the only `vscode`-importing module — two `TreeDataProvider`s
  and the `gascityCockpit.refreshStatus` command.

## Resilience: it expects the API to come and go

Reachability is *not* re-implemented here — it is owned by the existing
`ConnectionManager`. `extension.ts` connects the live status only when the
manager reports `connected`, reconnects on a detected supervisor restart
(`build_id` change) or an endpoint/token change, and tears it down (keeping the
event history) on `unavailable`. The SSE subscription adds its own
reconnect/backoff for the stream itself. Net effect: stopping a city (`gc stop`)
or restarting the supervisor degrades the panes gracefully and they recover on
their own.

## UI

A "GasCity Cockpit" activity-bar container with two views:

- **Fleet** — `Supervisor` (health/version/uptime) → each city → `Agents (n)` /
  `Sessions (n)` groups → items, each with a state icon, a one-line description,
  and a rich Markdown tooltip. A title-bar **Refresh** forces an immediate
  snapshot; **Reconnect** re-runs discovery.
- **Event Feed** — a flat, newest-first list of supervisor events; failures and
  warnings are tinted, and the view title shows the live stream state.

## Tests

Seam-1 unit tests (no editor runtime), mirroring `src/api` / `src/discovery`:

- `store.test.ts` — model reducers, ring-buffer cap, event preservation.
- `snapshot.test.ts` — fetch fan-out against a mock /v0 server, partial-failure
  handling.
- `events.test.ts` — `parseFleetEvent`, `affectsStatusPanes`, and the durable
  stream's open → reconnect → `Last-Event-ID` threading, backoff, and abort.
- `live.test.ts` — connect/snapshot/subscribe, debounced refresh, mail-event
  filtering, and clean disconnect (no stale apply).
- `format.test.ts` — the pure presentation helpers.

`views.ts` is excluded from coverage — it is the thin VS Code adapter (PRD: the
editor-bound glue is kept small and not heavily unit-tested).
