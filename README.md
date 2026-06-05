<h1 align="center">GasCity Cockpit</h1>

<p align="center">
  <strong>Drive your whole fleet of gas cities from inside the editor — one adaptive, multi-tab cockpit, built entirely on the gascity <code>/v0</code> API.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Status-alpha-e0a020?style=for-the-badge" alt="Status: alpha">
  <img src="https://img.shields.io/badge/VS%20Code-extension-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="VS Code extension">
  <a href="https://github.com/gastownhall/gascity"><img src="https://img.shields.io/badge/Built%20on-Gas%20City%20%2Fv0-c9a84c?style=for-the-badge" alt="Built on Gas City /v0"></a>
  <img src="https://img.shields.io/badge/version-0.0.1-3b82f6?style=for-the-badge" alt="Version 0.0.1">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT License"></a>
</p>

GasCity Cockpit turns VS Code into a live cockpit for the gas cities you operate. Instead
of scattering your attention across a terminal (`gc`, `gc bd`, `gc mail`), a separate web
dashboard, and the editor where the code actually lives, the Cockpit pulls all of it onto
one adaptive surface — monitoring, the full beads backlog, interactive agent conversations,
native tool-approvals, and a jump from any bead to the polecat worktree and diff doing the
work. It is a **pure client** of the gascity `/v0` HTTP API served by the running supervisor
— the same versioned, self-documenting API the web dashboard already uses — so the expensive
machinery already exists and the Cockpit stays a thin, well-built window onto it. The full
product spec is in [`docs/PRD.md`](docs/PRD.md); this rig owns the extension + pack source.

> **New here?** A *gas city* is an orchestrated town of coding agents (a Mayor who
> coordinates, polecats who execute, witnesses and refineries who keep the work healthy and
> merged). Gas City — the engine — lives at
> [gastownhall/gascity](https://github.com/gastownhall/gascity). The Cockpit is how you
> *watch and drive* one from your editor.

## What You Get Today

Everything below is built and merged. The Cockpit is a working multi-pane surface — fully
keyboard-navigable and theme-aware (light / dark / high-contrast), with accessible names and
`aria-live` announcements throughout.

### The essentials

- **🌲 Beads explorer** — a multi-city tree of every work item: open / ready / in-progress /
  closed with rich status, filter and group by status / rig / assignee / type / priority,
  full bead detail, and rendered dependency graphs. (`src/beads`, `src/views`)
- **📟 Live status panes** — city health, agents, and sessions plus a real-time **event
  feed** streamed over SSE (`/health` + `/events/stream`), with a Fleet view that updates as
  your agents work. (`src/status`, `src/discovery`)
- **💬 Chat with the Mayor** — a structured conversation panel backed by the session
  transcript / submit / stream API: responses stream as they are produced, and you can send
  control intents including interrupting the autonomous loop. (`src/chat`)
- **✍️ Bead authoring** — create, update, close, reopen, assign, edit dependencies, and
  **dispatch (sling)** beads to a polecat pool, all without leaving the editor. (`src/beads`)
- **✅ Tool-approval cockpit** — surface pending tool-approval and input prompts across every
  session, answer them inline, and set permission mode (`/pending`, `/respond`,
  `/permission-mode`) — no more hunting for the right tmux pane. (`src/chat`, `src/api`)
- **🖥️ Dashboard projection** — embed ("project") the gascity dashboard directly as a Cockpit
  tab through a real webview embed contract: CSP/framing, VS Code theme-variable sync,
  deep-link/route control, and a host↔webview message bridge. (`src/dashboard`)
- **🧭 Code & worktree navigation** — jump from a bead to its polecat worktree and the diff
  for the work in flight, and preview/run formulas (e.g. the `tdd` formula) while watching
  their runs. (`src/code`, `src/formulas`)
- **🔌 First-class conversation participant** — the editor registers as a durable `extmsg`
  participant, so agents can address VS Code directly through the same conversation fabric
  the rest of the town uses. (`src/extmsg`)

### Power tools

- **⌨️ Fleet command palette** — natural-language queries (e.g. "show failing beads in
  cockpit") resolved into structured `/v0` queries across every city. (`src/fleet`)
- **🔀 In-editor merge-queue review** — surface refinery PRs with their diff and approve /
  merge in one click, closing the bead → polecat → merge loop without leaving the editor.
  (`src/mergeQueue`)
- **💸 Cost & tier telemetry** — model-advisor tier decisions and token-budget spend,
  visualized per agent and per bead. (`src/telemetry`)
- **🏷️ File a bead from a selection** — right-click any code selection to open a bead with
  `file:line` context auto-attached. (`src/features/beadFromSelection`)
- **🗺️ Live town topology** — an SSE-driven graph of controller → mayor → rigs →
  polecats / witness / refinery, color-coded by health. (`src/town`)
- **⏪ Event time-travel** — scrub and replay the event feed to reconstruct exactly what the
  agents did, for debugging and audit. (`src/timetravel`)
- **🔔 Native notifications** — VS Code toasts for escalations, tool-approvals, and mail, so
  nothing waits unseen in a background pane. (`src/notifications`)
- **🔎 Worktree code lens** — files annotated inline with the bead / polecat touching them
  right now. (`src/features/worktreeLens`)
- **📱 Companion surfaces** *(spike)* — groundwork and portability guarantees for a future
  web / mobile companion sharing the same typed `/v0` client. (`docs/companion-surfaces.md`)

Under all of it sits the foundation: a typed, OpenAPI-generated `/v0` client pinned to the
contract (`src/api`), a discovery + resilience layer that survives restarts / `gc stop`
(`src/discovery`), and a feature-registry host so every surface above is a self-contained,
parallel-mergeable module (`src/host`, `src/features`).

## Where This Is Going

The end state is a single **operator's cockpit** that makes the terminal-plus-browser-plus-editor
shuffle obsolete: open your editor and *see and steer* your entire fleet in real time —
every city's health, the whole backlog, every agent conversation, every approval, and the
exact code in flight — all driven by the existing `/v0` API, with no second tool to reach
for. The pieces above are the spine of that vision; the work now is depth, polish, and
reach: richer multi-city fleet management, a tighter monitoring → act → verify loop, and a
theming / auth / remote story solid enough to run against cities you don't own.

## What's Next

The entire wishlist from this README's first cut **shipped** — it became the Power tools
above. What's on the horizon now:

- **Telemetry, end to end** — the cost/tier pane is in, but full fidelity needs `/v0` to
  expose model-advisor and token-budget data; an upstream Gas City API change is filed.
- **Companion surfaces, for real** — the spike proved the core is portable; next is an actual
  web / mobile companion on the shared typed client.
- **Beyond localhost** — a remote + auth story so you can drive cities you don't own (v1 is
  localhost-only by design; the seams are already in place).
- **Consistent edges** — unified empty / loading / error states across every pane (in flight).

And a fresh batch we *haven't* started — **proposals very welcome**:

- **Multi-operator cockpit** — shared, presence-aware sessions over the same city.
- **Saved views & custom dashboards** — pin the queries and panes you live in.
- **Metrics over time** — throughput, cycle time, and reject rates per rig and per agent.
- **Replay → regression test** — turn an event-time-travel replay into a saved scenario test.

Have an idea that isn't here? That's exactly what the issue tracker is for. 👇

## Help Shape It — File an Issue

This is an early, fast-moving prototype, and the best way to push it forward is to tell us
where it falls short. **See a rough edge, a missing affordance, or a feature you wish
existed? [Open an issue](https://github.com/jsgerman-oss/gascity-cockpit/issues).** Bug
reports, UX papercuts, feature requests, and "why doesn't it just…" questions are all
genuinely wanted — every issue is a vote on where the Cockpit goes next.

## Architecture

The Cockpit is a **pure client** of the supervisor's `/v0` HTTP API. It adds no
long-running backend of its own. Everything talks to the API through one typed
seam so the editor-facing code stays thin and testable.

```
src/
  extension.ts          VS Code activation — build the host, activate features, start
  host/                 the connection core + the feature contract (thin glue)
    types.ts            FeatureHost, CockpitFeature, CONFIG_SECTION
    host.ts             createCockpitHost() — discovery, client, status bar, logger
  features/             one self-registering module per feature (parallel-mergeable)
    index.ts            the FEATURES registry + activateFeatures(host)
    <id>.feature.ts     a feature wires itself onto the host here
    <id>.contributes.json   that feature's package.json contributions (generated in)
  discovery/            endpoint discovery + resilience — NO `vscode` imports
    types.ts            shared contract types (descriptor, health, status)
    descriptor.ts       discovery descriptor parse / validate / build
    health.ts           /health probe + readiness
    discovery.ts        endpoint discovery precedence chain
    connection.ts       resilience state machine (reconnect, backoff, re-discover)
    index.ts            public barrel for the discovery/resilience core
  api/                  the typed /v0 client seam — NO `vscode` imports
    generated/          AUTO-GENERATED from openapi/openapi.json (do not edit)
      v0.d.ts             request/response types (openapi-typescript)
      spec-meta.ts        pinned info.title / info.version
    types.ts            friendly re-exports over the generated types
    client.ts           createCockpitClient() (openapi-fetch) + error normalization
    version.ts          version pinning + runtime compatibility check
    sse.ts              WHATWG-compliant Server-Sent Events reader
    index.ts            public barrel — import features from here
  beads/                the Beads explorer domain layer — NO `vscode` imports
    types.ts            domain model (records, filters, tree nodes) over /v0 beads
    status.ts           rich status / priority / rig derivation
    filter.ts           filter, group, and tree assembly
    detail.ts           bead detail → Markdown
    graph.ts            dependency graph → layered, themeable SVG / Mermaid
    repository.ts       multi-city fan-out over the bead endpoints
    index.ts            public barrel for the beads core
  status/ chat/ code/ dashboard/ extmsg/ formulas/ notifications/
                        feature domain cores added since Phase 1 — each follows the
                        same pattern: a `vscode`-free, unit-tested core plus thin glue
  views/                VS Code surfaces (thin glue, kept untested)
    beadsExplorer.ts    tree provider + detail document + graph webview + commands
  test/                 shared test helpers (mock fetch, stream builders)
media/                  activity-bar icon
docs/                   PRD + contracts
```

- **Discovery + resilience.** The extension finds the supervisor via an explicit
  setting, a discovery descriptor, or the localhost default; probes `/health`;
  and keeps a status-bar indicator live across `gc stop` / supervisor restarts
  with exponential-backoff reconnect. The core has no `vscode` import and is
  unit-tested in plain Node. See
  [docs/api-discovery-and-resilience.md](docs/api-discovery-and-resilience.md).
- **Typed client.** [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/)
  over types generated by
  [`openapi-typescript`](https://openapi-ts.dev/) from the live `/openapi.json`
  (huma-generated, OpenAPI 3.1). The generated types are the single source of
  truth for `/v0` request/response shapes.
- **Version pinning.** The committed spec snapshot pins the contract version the
  client was built against (`PINNED_API_VERSION`). `checkApiCompatibility()`
  compares it to the live supervisor's `GET /health` at runtime and warns on
  drift — the supervisor is a moving dev build, so the check is informative, not
  a hard gate.
- **SSE.** `openapi-fetch` covers request/response; `sse.ts` adds a chunk-safe,
  reconnect-friendly reader for the `text/event-stream` endpoints that the live
  status and chat features build on.
- **Beads explorer.** A multi-city tree of beads with rich status
  (ready / blocked / deferred derived on top of the raw status), filter and group
  by status / rig / assignee / type / priority, a read-only Markdown bead detail,
  and a dependency-graph webview. The domain layer (`beads/`) has no `vscode`
  import and is unit-tested against a mock `/v0`; the editor surfaces (`views/`)
  are the thin glue. See [docs/beads-explorer.md](docs/beads-explorer.md).

## Prerequisites

- Node.js 20+ and npm.
- A running gascity supervisor. The API is auto-discovered and defaults to
  `http://127.0.0.1:8372` (override via the `gascityCockpit.api.url` setting).
  Confirm with `curl http://127.0.0.1:8372/health`.

## Development

```bash
npm install        # install dependencies
npm run generate   # regenerate the typed client from openapi/openapi.json
npm run compile    # bundle the extension to dist/ (esbuild)
npm run watch      # rebuild on change
npm test           # run the unit suite (vitest)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run check      # typecheck + lint + test (the pre-push gate)
```

Press **F5** ("Run Extension") to launch an Extension Development Host with the
Cockpit loaded. Run **GasCity Cockpit: Check API Connection** from the command
palette to verify the client reaches your supervisor and to see version
compatibility.

### Regenerating the client

The typed client is generated from `openapi/openapi.json`, a committed snapshot
of the supervisor's `/openapi.json`. Generation is reproducible offline:

```bash
npm run generate         # from the committed snapshot
npm run generate:live    # refresh the snapshot from a running supervisor, then generate
```

`generate:live` honors `GASCITY_API_URL` (default `http://127.0.0.1:8372`).
Commit the regenerated `openapi/openapi.json`, `src/api/generated/v0.d.ts`, and
`src/api/generated/spec-meta.ts` together — they move as a unit and pin the `/v0`
version.

### Packaging

```bash
npm run package    # produces a .vsix (vsce, dependencies bundled by esbuild)
```

## Testing

Tests follow the seams in the PRD's Testing Decisions and run under one runner
(`vitest run`):

- **Seam 1 (here):** the `vscode`-free core — the typed `/v0` client and the
  discovery/resilience state machine — exercised against an injected mock
  `fetch` / `fs` (an OpenAPI-conformant mock `/v0`). Provider-agnostic, no editor
  runtime, no real sockets — this is where most behavior is proven.
- **Seam 2 (later):** the webview ↔ extension-host postMessage protocol.
- **Seam 3 (later):** a thin set of live-contract checks against a real
  supervisor, asserting the `/v0` shapes the Cockpit depends on have not drifted.

Neither `api/` nor `discovery/` imports `vscode`, which is exactly what keeps
Seam 1 runnable in plain Node.

## Security / dependency audit

`npm audit` reports advisories in the **dev-only** vite/vitest toolchain
(transitive `esbuild`/`vite`), including one critical that requires the Vitest
**UI** server (`vitest --ui`) to be listening. We run tests headless
(`vitest run`) and never ship these: the `.vsix` contains only the bundled
`dist/extension.js`. The direct `esbuild` used for bundling is on a patched
line. Clearing the remaining advisories requires a breaking Vitest v4 upgrade,
deferred until it is stable.

## Documentation

- [PRD](docs/PRD.md) — problem, solution, and full user-story set
- [Contributing a feature](docs/contributing-features.md) — the feature registry + parallel-merge guardrails
- [API discovery & resilience](docs/api-discovery-and-resilience.md)
- [Beads explorer](docs/beads-explorer.md)
- [Live status panes](docs/live-status-panes.md)
- [Dashboard embed contract](docs/dashboard-embed-contract.md)
- [Extmsg participant](docs/extmsg-participant.md)
- [Merge queue review](docs/merge-queue-review.md)
- [Native notifications](docs/notifications.md)
- [Worktree code lens](docs/worktree-code-lens.md)

## Contributing

Issues and PRs are welcome — see [Help Shape It](#help-shape-it--file-an-issue) above. The
feature logic lives behind `vscode`-free domain cores (`src/api`, `src/discovery`, and each
feature module) and is unit-tested with vitest; the VS Code activation layer
(`src/extension.ts`) is kept deliberately thin. A feature is a self-contained module under
`src/features/` that registers itself onto the shared host and carries its own
`package.json` contributions — so features merge in parallel without touching `extension.ts`
or hand-editing `package.json`. See **[Contributing a feature](docs/contributing-features.md)**
for the full pattern and the parallel-merge guardrails (thin activation, `vscode`-free cores,
per-feature contributes manifests, rebase-on-latest-`main`, and the `npm run check` gate).

---

<p align="center"><sub>Built on <a href="https://github.com/gastownhall/gascity">Gas City</a> · a client of the <code>/v0</code> supervisor API</sub></p>
