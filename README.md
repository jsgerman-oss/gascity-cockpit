# GasCity Cockpit

A VS Code extension (the client) plus a thin enabling gascity pack (the city-side
contract): an adaptive cockpit into your gas cities, built on the gascity /v0 HTTP API.

Planning lives in epic **bh-bsmt** (blackrim-hq beads). This rig owns the extension + pack source.

## Status

Foundation in place: **API discovery + resilience** — how the extension finds
the supervisor API and stays usable as it comes and goes (`gc stop`, supervisor
restart). See [docs/api-discovery-and-resilience.md](docs/api-discovery-and-resilience.md).

## Layout

```
src/
  extension.ts          VS Code activation glue (thin; status bar, commands, settings)
  discovery/            vscode-free, unit-tested core:
    types.ts            shared contract types (descriptor, health, status)
    descriptor.ts       discovery descriptor parse / validate / build
    health.ts           /health probe + readiness
    discovery.ts        endpoint discovery precedence chain
    connection.ts       resilience state machine (reconnect, backoff, re-discover)
    *.test.ts           node:test suites for the seams above
docs/                   PRD + contracts
```

## Development

Requires Node 20+ (uses native fetch and TypeScript type-stripping for tests).

```bash
npm install
npm test         # node --test — runs the discovery/resilience seam tests (no test deps)
npm run typecheck
npm run build    # esbuild bundle -> out/extension.cjs
```

The `discovery/` core has no `vscode` import and is the primary test seam
(PRD "Seam 1"); the editor-bound glue in `extension.ts` is kept thin.
