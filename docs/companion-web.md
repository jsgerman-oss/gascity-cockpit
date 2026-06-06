# The Web Companion (localhost, read-only)

> Status: **SHIPPED** (`cockpit-dc8.7`). The first running companion surface —
> a localhost, read-only web dashboard over `/v0`, built on the portable
> [`src/core`](./core-boundary.md) boundary. This is the companion-surfaces
> spike's **Phase 2 — Web companion MVP**
> ([companion-surfaces.md](./companion-surfaces.md#proposed-sub-epic-to-ratify));
> it follows the multi-target scaffold (`cockpit-dc8.4`) and is the first proof
> the reuse premise holds end-to-end in a browser, not just on paper.

## What shipped

A browser app at [`targets/web`](../targets/web) that surfaces three read-only
panes — **Fleet**, **Beads**, **Telemetry** — over the same typed `/v0` client
and domain cores the VS Code extension uses. It is the only way to get Cockpit
panes outside VS Code; Zed and JetBrains extensions are headless and cannot host
the webview panels (`cockpit-dc8` theme).

| Pane | Source (reused from `core`) | Liveness |
|---|---|---|
| **Fleet** | `core.status.fetchFleetSnapshot` → supervisor health, cities, agents, sessions | snapshot + Refresh + 15s poll |
| **Beads** | `core.beads.BeadsRepository.loadExplorer`, filtered/sorted with `DEFAULT_FILTERS` (hides closed + operational wisps, exactly like the explorer) | snapshot + Refresh |
| **Telemetry** | `core.telemetry` `TelemetryStore` + `LiveTelemetry` + `TelemetryStream` over the `worker.operation` **SSE** feed | live (event-sourced) |

The loading / empty / error rows reuse the shared cross-pane vocabulary
([`src/ui/view-state`](../src/ui/view-state.ts),
[cross-pane-states.md](./cross-pane-states.md)) — the same `Connecting to
supervisor…` and `Couldn't load <resource>.` copy the editor panes show — so a
companion pane and an editor pane read in the same key. The per-row labels come
from the same `core` formatters (`status`/`telemetry`/`beads`), so there is no
copy to drift.

### Files

| File | Role |
|---|---|
| [`render.ts`](../targets/web/render.ts) | Pure `data → HTML` for each pane (no DOM/IO); unit-tested with fixtures |
| [`app.ts`](../targets/web/app.ts) | DOM-free orchestration: create client, fetch snapshots, drive the SSE telemetry store, render via an injected `mount` |
| [`main.ts`](../targets/web/main.ts) | The thin DOM shell (the esbuild entry); wires `mount` to `innerHTML` and owns the timer |
| [`index.html`](../targets/web/index.html) / [`styles.css`](../targets/web/styles.css) | The static shell, copied beside the bundle into `dist/web/` |
| [`serve.mjs`](../targets/web/serve.mjs) | The launch server: serves the bundle and reverse-proxies `/v0` (see CORS, below) |
| [`tsconfig.json`](../targets/web/tsconfig.json) | The one target with the **DOM lib** (the Node/extension root config omits it) |

This shape mirrors the CLI target (`render` pure, `app`/logic testable, `main`
the thin entry) — the pattern [core-boundary.md](./core-boundary.md#adding-a-new-sibling-target)
prescribes for a sibling target.

## Launching it

```bash
npm run web          # compile all targets, then serve dist/web on http://127.0.0.1:4178
# or, against an already-built bundle / a non-default supervisor:
node targets/web/serve.mjs --port=4178 --supervisor=http://127.0.0.1:8372
```

Then open `http://127.0.0.1:4178/`. The build (`npm run compile` / `npm run
build`) emits a self-contained static bundle in `dist/web/` (`app.js` +
`index.html` + `styles.css`) — `serve.mjs` is only the localhost host; the
bundle itself is static and could be served by anything once CORS lands.

## Why a proxy — the CORS story

`serve.mjs` does two jobs: serve the static bundle **and** reverse-proxy
`/health` and `/v0/*` (including the `/v0/events/stream` SSE feed) to the
supervisor. That makes every API call **same-origin**.

This is deliberate. A browser app on its own origin calling the supervisor on
`:8372` is a cross-origin request, and the supervisor does not yet send CORS
headers — the spike's **Phase-3, server-side** gap
([companion-surfaces.md §The gaps](./companion-surfaces.md#the-gaps--what-is-not-free),
[remote-and-auth.md](./remote-and-auth.md)), owned by gastown, not the Cockpit.
Proxying through one origin sidesteps it so Phase 0 runs end-to-end on localhost
**today**, without waiting on that server-side work. The app defaults its `/v0`
base URL to the page origin; an explicit `?endpoint=<url>` override points it
straight at a supervisor for the day CORS exists.

The server binds `127.0.0.1` only: Phase 0 is the *local-supervisor* surface.
No auth and no writes — real tokens + TLS gate any remote or mobile deployment.

## Where this sits in the phase plan

Reconciling two numbering schemes: the **work bead** (`cockpit-dc8.7`) calls
this the web companion's "Phase 0" — its first shippable slice. In the
**spike's** sub-epic numbering it is **Phase 2 — Web companion MVP**. Same
deliverable; this doc is the authoritative record of what landed.

What is **not** in this phase, and what unblocks it:

| Deferred | Blocked on |
|---|---|
| Writes / dispatch / chat / approvals on the companion | identity & approval authority (spike gap 5) |
| Any **remote** (non-loopback) web deployment | `/v0` CORS + issued tokens + TLS (spike Phase 3, gastown-owned) |
| **Mobile** (PWA-first, then native if wanted) | spike Phase 3 |

The data, derivation, formatting, and SSE layers these would build on are
already reused here unchanged — the remaining work is server-side enablers and
per-surface UI, exactly as the spike scoped it.

## Tested

`npm run check` covers the target: `render.ts` and `app.ts` are unit-tested
(plain Node, fake `mount` + fake `core` seams — no browser, no network), the
core-portability guard stays green, and the browser `tsconfig` typechecks the
DOM shell. The launch path (static serving + `/v0` proxy + live SSE streaming)
was verified against a running local supervisor.
