# Cost & Tier Telemetry

> Status: **BUILT** (`src/telemetry/`, `src/views/telemetry.ts`). Implements
> cockpit-21l.3. Builds on the feature registry (cockpit-1ll.15, `src/features/`)
> and the typed `/v0` client + SSE reader (cockpit-1ll.1, `src/api/`). Consumes
> the same supervisor event stream as the live status panes (cockpit-1ll.6).

A VS Code tree view — **Cost & Tier** — that attributes worker/LLM activity
**per agent** and **per bead**, each broken down by **model** (the closest proxy
the `/v0` contract gives us for an advisor *tier*). It streams the supervisor's
`worker.operation` events, rolls them up live, and is honest about what the API
does not yet measure.

## Why this exists

The bead: *"Visualize model-advisor tier decisions and token-budget spend per
agent and per bead. If `/v0` does not expose advisor/budget data, file an
upstream gastown bead for the API."*

Both halves of that conditional turned out to apply, so this feature does both:
it **ships the surface** against the one telemetry source `/v0` exposes, and an
**upstream bead** (cockpit-910) tracks the data the API still has to provide.

## What it reads

| Pane content | Source | Schema |
|--------------|--------|--------|
| Per-agent / per-bead / per-model rollups | `GET /v0/events/stream` (SSE), `type: "worker.operation"` | `WorkerOperationEventPayload` |

`worker.operation` is the only `/v0`-native record of per-`(agent, bead, model)`
work. One subscription drives the whole feed; non-`worker.operation` envelopes
are ignored client-side. The fields the rollups use:

| Field | Today | Used for |
|-------|-------|----------|
| `agent_name` → `session_name` | best-effort | agent attribution (falls back to `(unattributed)`) |
| `bead_id` | best-effort | bead attribution (falls back to `(no bead)`) |
| `model`, `provider` | best-effort, may be absent | the per-model (tier-proxy) breakdown |
| `operation`, `result`, `error`, `duration_ms` | present | op counts, success/failure, duration |
| `prompt_tokens`, `completion_tokens`, `cache_*_tokens` | **"currently always absent"** | token-budget spend |
| `cost_usd_estimate` | **"currently always absent"** (#1255 pricing seam) | cost |

## Honest by construction (graceful degradation)

The Cockpit binds to the token/cost fields **now** and treats *absent* as
distinct from *zero*: a rollup only counts a measurement when the supervisor
actually reports one (`TokenTotals.measuredOps`). While nothing is measured the
pane shows `—` for tokens/cost and a notice — *"Tokens & cost not yet
instrumented"* — instead of a misleading `$0.00`. The moment upstream populates
the fields, the same surface lights up with **zero cockpit changes**.

What it shows **today** (real data): per-agent and per-bead operation counts,
success/failure, total duration, and the model(s) / provider(s) each used.

## The upstream gap → cockpit-910

The Cockpit is a pure `/v0` client and cannot reach two things:

1. **Advisor tier decisions** — not in `/v0` at all. The advisor records each
   dispatch (advised-vs-baseline tier, shape, `tok_in`/`tok_out`) only to a local
   `advisor.v1` log (`.beads/telemetry/invocations.jsonl`).
2. **Token/cost population** — `WorkerOperationEventPayload` declares the fields
   but the supervisor leaves them absent (#1255 / #1256).

Both are requested in **cockpit-910** (`discovered-from` cockpit-21l.3). Until it
lands, the model breakdown stands in for tier and tokens/cost render as `—`.

## Architecture

Per the PRD Testing Decisions, all logic lives behind a provider-agnostic,
`vscode`-free **Seam 1** core; the editor binding is a thin adapter that is
intentionally not unit-tested. It mirrors the live status feature
(`store` ← `stream`, driven by a `live` lifecycle, rendered by a tree view).

```
src/telemetry/            Seam 1 — NO `vscode` imports (unit-tested under vitest)
  types.ts                WorkerOperation, ScopeRollup, ModelRollup, TokenTotals, TelemetryState
  events.ts               parseWorkerOperation() + durable TelemetryStream (own SSE, parses payload)
  store.ts                TelemetryStore — seq-deduped rollups, per-model breakdown, scope cap, totals
  format.ts               compact token/cost/duration formatting + the "—" degradation
  live.ts                 LiveTelemetry — wires stream → store; connect/disconnect lifecycle
  index.ts                public barrel
src/views/telemetry.ts    thin VS Code adapter: the "Cost & Tier" TreeDataProvider + Clear command
src/features/telemetry.feature.ts        self-registers on the host; connects only to a healthy supervisor
src/features/telemetry.contributes.json  the view + clear command (merged into package.json)
```

Notes for contributors:

- **Own subscription, by design.** The status feature's `parseFleetEvent`
  projects the envelope `payload` away, and the feature-merge guardrails forbid
  editing another feature's module — so telemetry opens its own `/v0/events/stream`
  subscription (over the shared `openSSE` + `backoffDelay`), exactly as
  `session-stream` does. Independent stream consumers are the established pattern.
- **Reconnect-safe counts.** The store drops any envelope whose `seq` was already
  applied, so a reconnect that replays events never double-counts.
- **Bounded memory.** Scopes are capped (`MAX_SCOPES`, default 200 per
  dimension); the least-recently-active is evicted while grand totals stay
  cumulative. Eviction surfaces a one-line notice.
