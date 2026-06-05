# API Discovery & Resilience Contract

> Status: **PROPOSED** (implements PRD open decision #4). The extension-side
> consumer in this document is **built and tested** (`src/discovery/`). The
> producer-side descriptor emission is a city/supervisor responsibility that is
> **not yet implemented anywhere** — see [Producer requirement](#producer-requirement-the-gap).
> Major forks are flagged in [Open forks](#open-forks-to-ratify).

This is the foundation the rest of the Cockpit builds on (cockpit-1ll.5 beads
explorer, cockpit-1ll.6 live status panes, chat, …): *how the extension finds
the gascity API, and how it stays usable as that API comes and goes.*

## Why this exists

The Cockpit is a pure client of the gascity `/v0` HTTP API served by the
supervisor. Two facts make "just hard-code the URL" wrong:

1. **There is no machine-readable address today.** The supervisor logs
   `Supervisor API listening on http://127.0.0.1:8372` and that is the only
   record — found by inspection, not contract. A non-default port is
   undiscoverable.
2. **The API is transient.** `gc stop` takes the API down with the city; a
   supervisor restart can change its identity (and, in principle, its port). The
   Cockpit must treat availability as a fact that changes, not a constant.

So discovery is a defined precedence chain, and the connection is a state
machine that expects the API to disappear and come back.

## Deployment modes

The API runs in one of two shapes (cf. the `gc dashboard` discovery rules):

| Mode | Who serves | Default address | Routing |
|------|-----------|-----------------|---------|
| `supervisor` | machine-wide `gc` supervisor (one per machine) | `http://127.0.0.1:8372` | per-city under `/v0/city/{name}/…`; cities via `/v0/cities` |
| `standalone` | a single city started with `gc start` | city's `city.toml` `[api] port` | that city only |

`/health` and `/v0/cities` distinguish them at runtime: supervisor mode answers
`/v0/cities` with the managed set.

## Discovery: which API to talk to

`resolveEndpoint()` (`src/discovery/discovery.ts`) tries candidates in strict
precedence and **accepts the first one whose `/health` probe succeeds**:

1. **Settings override** — `gascityCockpit.api.url` (+ optional `…api.token`).
   The escape hatch for non-standard setups (equivalent to `gc dashboard --api`).
2. **Discovery descriptor** — a small JSON file a Cockpit-ready city writes:
   - machine supervisor: `~/.gc/api.json`
   - standalone city: `<cityRoot>/.gc/runtime/api.json` (mirrors where packs
     write runtime state today, e.g. `.gc/runtime/packs/dolt/dolt-state.json`)
3. **Documented default** — `http://127.0.0.1:8372` (supervisor).

Two properties fall out of probing every rung:

- **A stale descriptor is self-correcting.** If a descriptor points at a port
  that no longer answers (e.g. after a restart on a new port), the probe fails
  and discovery falls through — it never hands back a dead endpoint.
- **It works today, with no descriptor.** Since the default rung needs no file,
  the Cockpit connects against the current supervisor as-is. The descriptor is a
  *better* signal, never a *required* one. (Verified live: with no
  `~/.gc/api.json`, discovery resolves `source=default, mode=supervisor`.)

Every rung tried is recorded in `DiscoveryResult.attempts` so the
"API unavailable" UI can explain *why* nothing connected.

## The discovery descriptor

Field naming mirrors existing gascity runtime JSON (snake_case, RFC3339). Schema
in `src/discovery/types.ts` (`ApiDescriptor`); parse/validate/build in
`src/discovery/descriptor.ts`.

```json
{
  "schema_version": 1,
  "base_url": "http://127.0.0.1:8372",
  "scheme": "http",
  "host": "127.0.0.1",
  "port": 8372,
  "mode": "supervisor",
  "api_version": "0.1.0",
  "token": null,
  "pid": 62633,
  "build_id": "efd98eb6…-dirty",
  "started_at": "2026-06-05T06:24:22Z"
}
```

| Field | Req | Meaning |
|-------|-----|---------|
| `schema_version` | ✓ | Descriptor schema; consumer rejects versions newer than it understands (currently `1`). |
| `base_url` | ✓¹ | Canonical base URL, no trailing slash. ¹Derived from `scheme`/`host`/`port` if absent. |
| `scheme` / `host` / `port` | ✓ | Listener address parts. |
| `mode` | ✓ | `supervisor` \| `standalone`. |
| `api_version` | ✓ | `/openapi.json` `info.version`, for [compatibility](#compatibility). |
| `token` | – | Bearer token, or `null`/absent when unauthenticated (the case today). |
| `pid` / `build_id` / `started_at` | – | Provenance; `build_id` aids restart detection. |

**Producer rules** (for whoever writes it):

- Write **atomically** (temp file + rename) so a reader never sees a partial
  descriptor. `serializeDescriptor()` is newline-terminated for this.
- Write on API start; **remove on clean shutdown** (`gc stop`). A leftover file
  is tolerated by the consumer (the probe catches it) but removing it is cleaner.
- The file is a *hint*. The server need not block startup on writing it.

## Resilience: staying connected

`ConnectionManager` (`src/discovery/connection.ts`) is the state machine. All of
its side effects (discovery, probing, time, timers, randomness) are injected, so
it is fully unit-tested with a fake clock — no sockets.

```
        start()
          │
          ▼
   ┌─────────────┐  discover ok    ┌────────────┐  /health ok+ready  ┌───────────┐
   │ discovering │ ───────────────▶│ connecting │ ──────────────────▶│ connected │
   └─────────────┘                 └────────────┘                    └───────────┘
          │ no endpoint                  │ ok, !ready                       │ poll
          ▼                              ▼                                  │ every
   ┌──────────────┐  attempts<N     ┌──────────┐  ready                     │ pollIntervalMs
   │ reconnecting │◀────────────────│ degraded │◀───────────────────────────┘ (probe fails ⇒
   └──────────────┘  (backoff)      └──────────┘   drop endpoint, re-discover)
          │ attempts ≥ N
          ▼
   ┌──────────────┐
   │ unavailable  │  (keeps retrying at the backoff ceiling)
   └──────────────┘
```

| State | Meaning |
|-------|---------|
| `idle` | Not started / stopped. |
| `discovering` | Resolving an endpoint via the precedence chain. |
| `connecting` | Probing `/health` on a resolved endpoint (first connect only; routine polls stay `connected` to avoid UI flicker). |
| `connected` | `/health` is `ok` and `startup.ready`. Polls every `pollIntervalMs`. |
| `degraded` | Reachable but `startup.ready === false` (supervisor mid-startup). Polls fast (`degradedPollMs`). |
| `reconnecting` | Lost the API; backing off and will **re-discover** (not just re-probe). |
| `unavailable` | No endpoint reachable after `unavailableAfterAttempts` tries. Explicit dead state; the manager keeps retrying at the ceiling. |

Key behaviors:

- **Lifecycle-aware.** A failed poll (`gc stop`, restart) **drops the current
  endpoint** and re-runs full discovery on the next attempt, so a restart on a
  new port/descriptor is picked up. (Re-discovery on reconnect is tested.)
- **Backoff.** Exponential from `baseDelayMs`, capped at `maxDelayMs`, ±20%
  jitter (`backoffDelay()`), reset on every success.
- **Restart detection.** A changed `build_id` across successful probes sets
  `ConnectionStatus.restarted` once. Downstream consumers (SSE subscribers,
  caches in later beads) treat that as *resubscribe / invalidate* — important
  because event cursors and session streams don't survive a server restart.
- **Status is observable.** `onDidChangeStatus` fires a `ConnectionStatus` on
  every transition; the status bar and (later) panes render from it.

## The health probe

`/health` is the right liveness signal: **unversioned and top-level** (stable
across `/v0` churn), and it reports both reachability and readiness:

```json
{ "status": "ok", "version": "dev", "build_id": "…-dirty", "uptime_sec": 8593,
  "cities_total": 1, "cities_running": 1,
  "startup": { "ready": true, "phase": "running", "phases_completed": [ … ] } }
```

`isHealthy = status === "ok" && startup.ready`. `parseHealth()` is tolerant of a
missing `startup` block (older servers ⇒ assume ready) and strict about
`status`. The probe (`probeHealth()`) has a hard timeout and maps every failure
mode — unreachable, non-2xx, timeout, unparseable — to a single `ProbeError`, so
the state machine treats "couldn't confirm liveness" uniformly.

## Compatibility

The `/v0` surface is a moving dev build (`version: "dev"`). The descriptor's
`api_version` (and `/health.version` / `build_id`) let the Cockpit pin and
assert the API version its generated client expects, and surface a drift warning
rather than fail opaquely. Wiring the generated client + version assertion is a
**later bead**; this contract reserves the fields and the `restarted` signal it
will hang off.

## Settings surface

| Setting | Default | Purpose |
|---------|---------|---------|
| `gascityCockpit.api.url` | `""` | Explicit override (highest precedence). |
| `gascityCockpit.api.token` | `""` | Bearer token for override/default rungs. |
| `gascityCockpit.api.healthPollSeconds` | `10` | Poll cadence while connected. |
| `gascityCockpit.api.reconnect.baseDelayMs` | `500` | Backoff base. |
| `gascityCockpit.api.reconnect.maxDelayMs` | `15000` | Backoff ceiling. |

## Producer requirement (the gap)

Nothing writes `api.json` today. Until a Cockpit-ready pack/supervisor does, the
Cockpit relies on the default-`:8372` rung (works for the common machine-wide
supervisor). Closing the gap is a **gascity/gastown change**, to be filed there
(per the PRD: API gaps are filed against gastown, not built in this rig):

- On API start, write the descriptor atomically to the well-known path for the
  mode; remove it on clean shutdown.
- Populate `api_version` from the OpenAPI version and `build_id` from the build.
- (If/when auth lands) include the local `token`.

`buildDescriptor()` / `serializeDescriptor()` here are a runnable reference for
exactly the bytes the consumer expects, so the producer and a pack-side test can
share one definition.

## Open forks (to ratify)

Flagged per the dispatch note (decisions PROPOSED). None block this bead; the
consumer degrades safely whatever is chosen.

1. **Descriptor path & owner.** `~/.gc/api.json` (next to `cities.toml`,
   `supervisor.sock`) vs. an XDG runtime dir; written by supervisor core vs. the
   enabling pack. *Recommendation:* `~/.gc/api.json`, written by the supervisor
   (the pack only turns the API service on).
2. **Auth/token model.** Today localhost is unauthenticated; the descriptor
   reserves `token` but the identity/approval-authority model (PRD decision #5)
   is unresolved. *Recommendation:* keep `token` optional now; revisit with the
   auth bead before any remote story.
3. **Standalone multi-city.** One supervisor descriptor vs. per-city descriptors
   under each `<city>/.gc/runtime/`. *Recommendation:* per-running-API descriptor
   (machine supervisor ⇒ one; standalone ⇒ one per city), which the precedence
   chain already handles.

## Reference implementation map

| Concern | Module | Tested by |
|---------|--------|-----------|
| Shared types / descriptor & health schemas | `src/discovery/types.ts` | (consumed throughout) |
| Descriptor parse / validate / build | `src/discovery/descriptor.ts` | `descriptor.test.ts` |
| `/health` parse + probe | `src/discovery/health.ts` | `health.test.ts` |
| Discovery precedence chain | `src/discovery/discovery.ts` | `discovery.test.ts` |
| Connection state machine + backoff | `src/discovery/connection.ts` | `connection.test.ts` |
| VS Code glue (status bar, commands, settings) | `src/extension.ts` | thin; excluded per PRD |

Run the seam tests with `npm test` (`node --test`, no test dependencies).
