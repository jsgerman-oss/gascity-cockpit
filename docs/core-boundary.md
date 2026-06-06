# The Core Boundary & Multi-Target Build

> Status: **landed** (`cockpit-dc8.4`). Turns the portable surface the
> companion-surfaces spike audited ([companion-surfaces.md](./companion-surfaces.md))
> into a single importable boundary plus the build wiring a non-extension target
> needs. It is the scaffold the cross-editor fan-out (`cockpit-dc8.5/.6/.7`)
> builds on.

## What "core" is

`src/core` ([`index.ts`](../src/core/index.ts)) is the **one boundary** a
non-extension client imports. It re-exports the Cockpit's `vscode`-free,
Node-built-in-free half — the typed `/v0` client (sessions, approvals, beads,
formulas, SSE) and every domain core (bead derivation, telemetry, merge-queue,
fleet queries, town topology, discovery, city presentation, worktree lenses):

```ts
import * as core from "../../src/core/index.ts";

const client = core.api.createCockpitClient({ baseUrl });
const cities = await core.api.listCities(client);
const parsed = core.fleet.parseFleetQuery("blocked in:hq");
```

The barrels are re-exported as **namespaces** (`core.api`, `core.beads`,
`core.fleet`, …), not flattened. Two reasons:

- **No collisions.** The barrels have intentional name overlaps — e.g. both
  `api` and `discovery` export `normalizeBaseUrl`. A flat `export *` would
  silently drop whichever lost the clash; namespacing keeps every symbol
  reachable.
- **Legible call sites.** `core.fleet.runFleetQuery` says where it comes from.

The extension does **not** route through this barrel — it keeps importing the
individual cores directly, exactly as before (`cockpit-dc8.4` changed no
extension behaviour). `core` is additive: the consolidated surface that *other*
targets consume.

### What's in vs. out

| In `core` (portable) | Not in `core` (per-surface) |
|---|---|
| `src/api` — typed `/v0` client, SSE, sessions, approvals, beads/formulas calls | `src/views`, `src/features`, `src/host` — VS Code glue |
| `src/{beads,telemetry,mergeQueue,fleet,status,town,formulas,discovery,cities,code}` cores | `src/status/views.ts` — the tree adapter (the `status` barrel excludes it) |
| SVG/HTML string renderers (`town/render`, `beads/graph`) | `src/extmsg/callback-server.ts` — loopback socket, local-machine only |

## How the boundary is enforced

[`src/test/core-portability.test.ts`](../src/test/core-portability.test.ts)
walks the transitive **relative-import closure** of `core` (and the individual
barrels) and fails `npm run check` if any reachable module imports `vscode` or a
Node built-in. So the boundary cannot silently rot: a feature that leaks a host
dependency into a core fails at *its* PR, with the exact file and specifier —
not when someone first builds a companion. The guard "bites": add
`import * as vscode from "vscode"` to any core file and the test fails.

## The multi-target build

[`esbuild.mjs`](../esbuild.mjs) bundles a **list** of targets from a shared
config. Each target is `{ entryPoints, outfile, … }` merged over `common`
(`bundle`, `platform: node`, `target: node20`, …):

| Target | Entry | Output | Notes |
|---|---|---|---|
| extension | `src/extension.ts` | `dist/extension.js` | `vscode` external (provided by the editor) |
| fleet-status | `targets/cli/main.ts` | `dist/targets/fleet-status.js` | no `vscode`; `#!/usr/bin/env node` banner |
| mcp-gascity | `targets/mcp/main.ts` | `dist/targets/mcp-gascity.js` | no `vscode`; MCP server over stdio ([docs](./mcp-context-server.md)) |

`npm run compile` / `npm run build` build **all** targets; `npm run watch`
watches all of them. The CLI typechecks under `npm run typecheck` (`targets/` is
in [`tsconfig.json`](../tsconfig.json) `include`), is linted (`eslint src scripts
targets`), and its tests run under `npm run test` (vitest `include` covers
`targets/**`).

## The stub target: `fleet-status`

[`targets/cli`](../targets/cli) is a trivial Node CLI that prints the fleet over
`/v0` — the proof a non-extension entrypoint builds and runs against `core`:

- [`fleet-status.ts`](../targets/cli/fleet-status.ts) — a side-effect-free
  library (`parseArgs`, `collectFleet`, `run`) that imports `core` and calls
  `/v0/cities` → `/v0/city/{city}/agents`.
- [`render.ts`](../targets/cli/render.ts) — pure `data → string` formatting,
  decoupled from `core` so it unit-tests with plain fixtures.
- [`main.ts`](../targets/cli/main.ts) — the thin esbuild entry that invokes
  `run`, kept separate so test imports of the library spawn no I/O.

Build and run it:

```bash
npm run build
node dist/targets/fleet-status.js                 # localhost supervisor default
node dist/targets/fleet-status.js http://host:port
GASCITY_API_URL=http://host:port npm run fleet-status
node dist/targets/fleet-status.js --help
```

## Adding a new sibling target

The fan-out targets (the landed [MCP server](./mcp-context-server.md); an ACP
adapter and web companion next) follow the same shape — no build reinvention:

1. Add `targets/<name>/` with an entry that `import * as core from
   "../../src/core/index.ts"` (or the specific namespaces it needs).
2. Add one entry to `buildTargets` in [`esbuild.mjs`](../esbuild.mjs)
   (`entryPoints` + `outfile`; set `external`/`format`/`platform` only if it
   differs from a Node CLI — e.g. a web target uses `platform: "browser"`).
3. Keep host-bound code out of `core`; the portability guard enforces it.

## Relationship to the companion sub-epic

This is the in-repo enabler the spike called
**Phase 1** ([companion-surfaces.md §Proposed sub-epic](./companion-surfaces.md#proposed-sub-epic-to-ratify)),
scoped pragmatically: a `src/core` boundary + multi-target esbuild here, rather
than a full npm-workspaces extraction. The boundary and the targets are real and
guarded today; promoting `core` to a published `@cockpit/core` workspace package
(with a path alias or package `exports` so targets import it by name instead of a
relative path) is the natural next step if/when this repo becomes a monorepo —
the import surface (`core.api`, `core.fleet`, …) is already what such a package
would expose.
