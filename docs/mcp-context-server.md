# The MCP Context Server (`mcp-gascity`)

> Status: **landed** (`cockpit-dc8.6`). A Model Context Protocol server that
> exposes a gascity supervisor's `/v0` API as tools to *any* MCP client — Zed
> context servers, VS Code Copilot, Claude Code — over stdio. One server, many
> clients: the high-leverage cross-editor fan-out the
> [core boundary](./core-boundary.md) was built for.

## What it is

`mcp-gascity` is a sibling **build target** ([`targets/mcp`](../targets/mcp)),
exactly like the [`fleet-status` CLI](./core-boundary.md#the-stub-target-fleet-status):
a `vscode`-free Node entrypoint that imports the shared core boundary
(`src/core`) and talks to a supervisor through the same typed `/v0` client the
extension uses. Instead of printing once and exiting, it speaks
[MCP](https://modelcontextprotocol.io) over stdio so an editor's AI can query
your fleet as first-class tools.

It is **read-mostly**: five read tools, plus one mutating tool that is disabled
unless you opt in.

| Tool | Reads | Returns |
|---|---|---|
| `fleet_status` | `/v0/cities` + `/v0/city/{c}/agents` | every city, running state, and its agents |
| `query_beads` | `/v0/city/{c}/beads` (+ `…/ready`) | beads filtered by status / rig / assignee / type / text, or a natural-language query |
| `merge_queue` | beads (derived) | entries awaiting / rejected / merged by the refinery |
| `telemetry` | `/v0/city/{c}/events` (`worker.operation`) | cost & tier rollups per city, per agent, per model |
| `recent_events` | `/v0/city/{c}/events` | recent supervisor events, newest first |
| `sling_bead` ⚠️ | `POST /v0/city/{c}/sling` | dispatches a bead — **gated**, see [Writes](#writes-are-opt-in) |

All read tools are **multi-city aware**: with no `city` argument they fan out
across every running city the supervisor serves; pass `city` to scope to one.
Per-city load failures are isolated and surfaced as `partial` + `errors` rather
than failing the whole call. Every tool maps a `/v0` problem document to a clean
MCP tool error (`isError`) carrying the title, detail, and request id.

## Build it

```bash
npm install
npm run build                 # builds all targets, incl. dist/targets/mcp-gascity.js
node dist/targets/mcp-gascity.js --help
```

The server defaults to the localhost supervisor. Point it elsewhere with a
positional endpoint, `--endpoint=URL`, or `$GASCITY_API_URL`:

```bash
node dist/targets/mcp-gascity.js http://127.0.0.1:8372
GASCITY_API_URL=http://host:port npm run mcp-gascity
```

It communicates on **stdout/stdin** (newline-delimited JSON-RPC); all logging
goes to **stderr**, so an MCP client's stdio channel stays clean.

## Install it in a client

Use an **absolute path** to the bundled file in every client below
(`/ABS/PATH` = the absolute path to this repo's checkout).

### Zed

Zed configures custom MCP servers under `context_servers` in `settings.json`
(open with `zed: open settings`):

```json
{
  "context_servers": {
    "gascity": {
      "command": {
        "path": "node",
        "args": ["/ABS/PATH/dist/targets/mcp-gascity.js"],
        "env": {}
      },
      "settings": {}
    }
  }
}
```

Point it at a non-default supervisor by adding the endpoint to `args`
(`["/ABS/PATH/dist/targets/mcp-gascity.js", "http://host:port"]`) or via
`"env": { "GASCITY_API_URL": "http://host:port" }`.

### VS Code (Copilot agent mode)

Add a workspace `.vscode/mcp.json` (or your user `mcp.json`):

```json
{
  "servers": {
    "gascity": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/targets/mcp-gascity.js"]
    }
  }
}
```

Open the file and click **Start**, or run **MCP: List Servers**. The tools then
appear in the Copilot Chat agent-mode tool picker.

### Claude Code

Add a project-scoped `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "gascity": {
      "command": "node",
      "args": ["/ABS/PATH/dist/targets/mcp-gascity.js"]
    }
  }
}
```

…or register it from the CLI:

```bash
claude mcp add gascity -- node /ABS/PATH/dist/targets/mcp-gascity.js
```

Confirm with `/mcp` inside Claude Code, or `claude mcp list`.

## Writes are opt-in

`sling_bead` is the only tool that mutates the fleet. It is **disabled by
default**: called without the opt-in, it returns an `isError` result and issues
no request. Enable it explicitly when you trust the client:

```bash
node dist/targets/mcp-gascity.js --allow-writes
# or
GASCITY_MCP_ALLOW_WRITES=1 node dist/targets/mcp-gascity.js
```

When enabled, `sling_bead` routes a bead to an agent/pool (and can attach a
formula / launch a workflow) through the same `BeadsClient.sling` path the
extension uses — including the required `X-GC-Request` anti-CSRF header.

## How it is built (for contributors)

The target mirrors the CLI's thin-shell-over-pure-core shape, so the logic worth
testing carries no I/O:

- [`tools.ts`](../targets/mcp/tools.ts) — the **tool registry**: each tool is a
  pure `{ name, description, inputSchema, handler }`. Handlers reach the
  supervisor only through `src/core`, so the whole module is unit-tested against
  a mock-fetch client (no sockets, no `vscode`).
- [`protocol.ts`](../targets/mcp/protocol.ts) — the **JSON-RPC / MCP dispatcher**:
  a pure `message → response` function handling `initialize`, `tools/list`,
  `tools/call`, `ping`, and notifications. No stdio, so the handshake is tested
  with plain objects.
- [`server.ts`](../targets/mcp/server.ts) — the I/O shell: `parseArgs`,
  `buildContext`, and the stdio pump. Only this file touches real streams.
- [`main.ts`](../targets/mcp/main.ts) — the thin esbuild entry.

Tests live beside them ([`tools.test.ts`](../targets/mcp/tools.test.ts),
[`protocol.test.ts`](../targets/mcp/protocol.test.ts)) and run under
`npm run check`. The end-to-end gate — list tools and answer a `fleet_status`
call against a stub `/v0` — is the `tools/call` suite in `protocol.test.ts`.

### A note on telemetry

`telemetry` rolls up the `worker.operation` event feed — the sole `/v0` source
of per-(agent, bead, model) cost data (see
[cost-tier-telemetry.md](./cost-tier-telemetry.md)). It folds each city's events
through the tested `parseWorkerOperation` → `TelemetryStore` path, one store per
city (the store de-duplicates by the city-local `seq`, so cities are kept
isolated). Token/cost fields read live but the supervisor reports them as
unmeasured today; `anyCostMeasured` flags whether any landed, and a `note` says
so — operation counts and durations are always exact.

## Relationship to the fan-out sub-epic

This is the second sibling target after the CLI, and the first to carry real
cross-editor value. It changes nothing in the extension and reinvents no build —
it adds one `targets/mcp` directory and one `esbuild.mjs` entry, exactly as
[core-boundary.md §Adding a new sibling target](./core-boundary.md#adding-a-new-sibling-target)
prescribes. An ACP adapter and a web companion are the remaining siblings.
