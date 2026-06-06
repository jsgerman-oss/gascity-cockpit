# `acp-mayor` — the Mayor as a Zed / ACP agent

> Status: **landed** (`cockpit-dc8.5`). The first cross-editor surface built on
> the multi-target scaffold ([core-boundary.md](./core-boundary.md)): a
> non-extension binary that exposes the **Mayor chat** to any
> [Agent Client Protocol](https://agentclientprotocol.com) client — Zed, the
> JetBrains ACP plugin, the VS Code ACP extension — over JSON-RPC on stdio.

## Why

The Cockpit's rich Mayor chat lives inside the VS Code extension. But the chat
slice is just a client of the `/v0` session API, and that API is editor-agnostic.
ACP is the lingua franca editors already speak to drive an external agent, so the
cheapest way to put the Mayor in Zed (and elsewhere) is to bridge ACP ⇄ `/v0`
rather than re-skin the chat per editor. `acp-mayor` is that bridge.

It deliberately exposes the **chat/agent slice only**. The dashboard, beads
explorer, and status panes are out of scope here — those are the web-companion's
job (see [companion-surfaces.md](./companion-surfaces.md)).

## What ACP gives the client

ACP is JSON-RPC 2.0 framed as newline-delimited JSON over stdio. The editor
(client) drives the lifecycle; the agent answers and streams back:

```
client → agent   initialize                negotiate protocol version + capabilities
client → agent   session/new               start a conversation, get a sessionId
client → agent   session/prompt            send the user's turn, await a stopReason
agent  → client  session/update            stream assistant text (agent_message_chunk)
agent  → client  session/request_permission ask the user to approve a tool action
client → agent   session/cancel            interrupt the in-flight turn
```

## The mapping

Everything routes through the shared typed `/v0` client from `src/core` — the
same `submit` / stream / `respond` surface the VS Code chat uses.

| ACP | /v0 |
|---|---|
| `session/new` | resolve the target city + Mayor session; `GET …/session/{id}` validates it |
| `session/prompt` (fresh) | `POST …/session/{id}/submit` (intent `default`) |
| `session/prompt` (answering a parked prompt-for-input) | `POST …/session/{id}/respond` with the text |
| per-session `turn` stream | `session/update` → `agent_message_chunk` (append-only deltas) |
| `pending` **tool-approval** | `session/request_permission` → `POST …/respond` with the chosen action |
| `pending` **prompt-for-input** | surfaced as an assistant message; the turn ends and the next prompt answers it |
| `--permission-mode` | `POST …/session/{id}/permission-mode` on `session/new` |
| `session/cancel` | abort the turn's stream → `stopReason: "cancelled"` |
| turn completion | `in-turn → idle` activity, stream close, or the city-event outcome backstop → `stopReason: "end_turn"` |

**Streaming deltas.** The `/v0` per-session `turn` events carry *full* transcript
snapshots; `AssistantDelta` projects each snapshot to only the new assistant text
so ACP receives clean `agent_message_chunk` deltas. This mirrors the proven VS
Code chat participant bridge (`src/chat/participant-bridge.ts`); the logic is
re-derived against `core.api` because the chat slice is per-surface glue, not part
of the portable `core` boundary.

**Permissions.** A `/v0` interaction's `options` (or the conventional
`["allow","deny"]` fallback) become ACP `PermissionOption`s; the `optionId` is the
verbatim `/v0` action string, so the operator's choice in Zed is echoed straight
back to `…/respond`. Option *kind* (`allow_once` / `reject_once` / `*_always`) is
inferred from the action word so Zed renders the right affordance.

## Architecture

A sibling build target under `targets/acp/`, following the `targets/cli`
(fleet-status) shape — import `core`, add one esbuild entry, ship. Four files,
split so the logic is `vscode`-free **and** exhaustively unit-testable without a
network or real stdio:

| File | Role | Pure? |
|---|---|---|
| [`protocol.ts`](../targets/acp/protocol.ts) | ACP wire types + a bidirectional ndjson JSON-RPC peer (`LineBuffer`, `JsonRpcPeer`) | yes — in-memory transports |
| [`bridge.ts`](../targets/acp/bridge.ts) | `MayorAgent` — the ACP ⇄ `/v0` mapping + turn projection | yes — injected `core.api` fakes |
| [`acp-mayor.ts`](../targets/acp/acp-mayor.ts) | `parseArgs` (config) + `serve` (wires the peer, agent, and stdio) | `serve` takes injected I/O |
| [`main.ts`](../targets/acp/main.ts) | thin esbuild entry over `process` stdio | — |

```
Zed ⇄ stdio ⇄ JsonRpcPeer ⇄ MayorAgent ⇄ core.api ⇄ /v0
            (protocol.ts)    (bridge.ts)
```

### The stdout invariant

In ACP stdio mode **stdout is the JSON-RPC channel**. Every diagnostic therefore
goes to stderr, never stdout — a stray `console.log` would corrupt the stream.
Inbound lines are dispatched *without awaiting* so a `session/cancel` is free to
interrupt the `session/prompt` it cancels instead of queuing behind it.

## Configuration

By flag or environment variable (flags win). See the
["Use the Mayor from Zed"](../README.md#use-the-mayor-from-zed) README section for
the table and the Zed `agent_servers` snippet. The city auto-resolves when the
supervisor serves exactly one; otherwise pass `--city`.

## Testing

All `vscode`-free, under `vitest` (the same Seam-1 discipline as the cores):

- `protocol.test.ts` — line framing, request/response correlation, notifications,
  error mapping, dispose.
- `bridge.test.ts` — the **ACP message mapping**: initialize, session/new
  (validate, auto-resolve, permission-mode), prompt → streamed chunks → end_turn,
  tool-approval → request_permission → respond, prompt-for-input round-trip,
  session/cancel → cancelled, and the error paths.
- `acp-mayor.test.ts` — `parseArgs`, plus an end-to-end **transport round-trip**:
  two wired peers driving `initialize → session/new → session/prompt` over the
  real framing against a stub `/v0`.

Gate: `npm run check` (typecheck + lint + test) and `npm run build`; the built
`dist/targets/acp-mayor.js` answers an `initialize` handshake on stdout.

## Build & run

```bash
npm run build
node dist/targets/acp-mayor.js --city=your-city          # speaks ACP on stdio
node dist/targets/acp-mayor.js --help
```

## Relationship to the cross-editor fan-out

This is the first of the `cockpit-dc8` fan-out targets the
[core boundary](./core-boundary.md) enabled (ACP adapter / MCP server / web
companion). It changes no extension behaviour and adds no dependency — it reuses
the typed client and the existing session API as-is.

**Stretch (not done):** submit `acp-mayor` to the Zed ACP agent registry so it's
installable without hand-editing `settings.json`. The wire surface is already
ACP-conformant (protocol version 1); registry packaging is the remaining step.
