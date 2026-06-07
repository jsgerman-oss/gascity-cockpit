# GasCity Cockpit — Web Companion

> Status: **core read surfaces** (`cockpit-c2o`, on the `cockpit-tzy` scaffold) —
> a slice of the companion epic ([`cockpit-gj9`](../../docs/companion-surfaces.md)).
> A standalone, read-only web companion built on the **same** typed `/v0` client
> and live domain store as the VS Code extension — imported, never forked.

This is the foundation the rest of the companion epic builds on (chat + approvals,
responsive/mobile, hosting). It presents four live read surfaces over the
supervisor's `/v0` API:

| Pane | Source (reused from `src/core`) | Liveness |
|---|---|---|
| **City Health** | `core.status.LiveStatus` → `fetchFleetSnapshot` (supervisor health and cities, each city's agents & sessions nested) | snapshot, auto-refreshed on every status-affecting event |
| **Agents** | the same snapshot, flattened fleet-wide through the `core.status.agentLabel` / `agentStatusKind` formatters the editor's Fleet tree uses | snapshot, auto-refreshed |
| **Sessions** | the same snapshot, flattened fleet-wide through the `core.status.sessionLabel` / `sessionStatusKind` formatters | snapshot, auto-refreshed |
| **Event Feed** | the same `core.status.SupervisorEventStream` over the `/v0/events/stream` **SSE** feed, buffered in `FleetStatusStore` | live (event-sourced) |

Every pane reads one `core.status.FleetStatusStore` — the extension's own live
status model — so the companion and the editor's Fleet pane render the same data,
the same way, with the same loading / empty / error states (the shared `src/ui`
cross-pane vocabulary). The Agents and Sessions panes are the entity-centric
counterpart to the city-centric Health pane: one scannable fleet-wide column each,
tagged by city when more than one is registered, instead of rows nested under
every city.

## Files

| File | Role |
|---|---|
| [`render.ts`](./render.ts) | Pure `state → HTML` for each pane (no DOM/IO); unit-tested with fixtures |
| [`app.ts`](./app.ts) | DOM-free orchestration: build the client + live store, connect, render via an injected `mount`; `resolveEndpoint` auto-discovery |
| [`main.ts`](./main.ts) | The thin DOM shell (the esbuild entry); wires `mount` to `innerHTML` |
| [`index.html`](./index.html) / [`styles.css`](./styles.css) | The static shell, copied beside the bundle into `dist/companion/` |
| [`serve.mjs`](./serve.mjs) | The launch server: serves the bundle and reverse-proxies `/v0` |
| [`tsconfig.json`](./tsconfig.json) | The browser (DOM-lib) typecheck project |

## Running it

From the repo root:

```bash
npm run companion          # compile all targets, then serve dist/companion on http://127.0.0.1:4180
```

Or, against an already-built bundle / a non-default supervisor:

```bash
npm run compile
node packages/companion/serve.mjs --port=4180 --supervisor=http://127.0.0.1:8372
```

Then open `http://127.0.0.1:4180/`.

### Endpoint auto-discovery

`resolveEndpoint` defaults the `/v0` base URL to the **page origin** — the launch
server serves this bundle and reverse-proxies `/v0`, so every API call is
same-origin and sidesteps the supervisor's not-yet-shipped CORS headers (the
[companion-surfaces](../../docs/companion-surfaces.md) Phase-3, server-side gap).
Overrides, for the day the supervisor speaks CORS:

- `?endpoint=http://host:port` — talk to a supervisor directly.
- `?token=…` — thread a bearer token onto every request and the SSE stream (the
  seam a future auth model fills; unused on localhost today).

The server binds `127.0.0.1` only: this is the local-supervisor surface. No auth
and no writes — real tokens + TLS gate any remote or mobile deployment
([remote-and-auth.md](../../docs/remote-and-auth.md)).

## Tested

`npm run check` covers the package: `render.ts` and `app.ts` are unit-tested in
plain Node (a fake `mount`, a mock `/v0` over an injected `fetch`, and an injected
SSE stream — no browser, no network), and the browser `tsconfig` typechecks the
DOM shell. The smoke test drives the real typed client and live store against a
mock `/v0`, proving the reuse end-to-end. The launch path (static serving + `/v0`
proxy + live SSE) reuses the verified `targets/web` proxy shape.

## Relationship to `targets/web`

[`targets/web`](../../targets/web) is the read-only **PoC** the spike shipped
(`cockpit-dc8.7`): Fleet + Beads + Telemetry panes, a build target of the
extension. This package is the **standalone companion** the `cockpit-gj9` epic
grows — its own app surface and launch, reusing the same `src/core` boundary. The
two share the client and domain cores; neither forks the other.
