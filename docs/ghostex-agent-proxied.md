# D4b — gas-city-hosted, Ghostex-displays (the *proxied* agent-session model)

> Decision **D4** of the Ghostex ⇄ gascity-cockpit integration asks: when a
> gas-city agent "runs in Ghostex," **who owns the process?** Two paths are built
> on parallel branches so one can be chosen by merging it:
>
> - **D4a — Ghostex hosts** (`ghostex/agent-hosted`): `gx create-agent` spawns the
>   agent CLI *inside* a Ghostex pane; the Cockpit reaches into gxserver and drives
>   it through a chat panel.
> - **D4b — gas-city hosts, Ghostex displays** (`ghostex/agent-proxied`, this
>   branch): the gas-city supervisor owns the agent session; Ghostex shows a
>   **proxy/attach view** of it.
>
> This document describes D4b and lays it next to D4a so the ownership model can
> be chosen. Both branches stay open as PRs (`merge_strategy=mr`); merging one
> picks it.

## What D4b builds

A gas-city-owned agent session is **mirrored into a Ghostex terminal pane** and
**revealed (attached)** there. The operator keeps driving the agent through
gas-city — its true owner — and Ghostex is an attached, read-along window onto the
live transcript.

The data flow is the exact reverse of D4a:

```
D4a (hosted):    Ghostex agent session  ──readSessionText/events──▶  Cockpit chat panel
D4b (proxied):   gas-city agent session ──ConversationStore stream─▶  Ghostex proxy pane
                                          (sendSessionText / focusSession)
```

### Pieces

| Layer | File | Tested |
|---|---|---|
| **Core** — the mirror state machine | `src/ghostex/agentProxy.ts` (`GhostexSessionProxy`, `renderTranscript`, `paneAppend`) | unit, ~99% / 97% br |
| **Glue** — the command | `src/views/ghostexProxy.ts` (`registerGhostexProxy`) | vscode-bound, excluded |
| **Source of truth** (reused) | `src/chat/conversation-store.ts` (`ConversationStore`) | already tested |
| **Display client** (reused) | `src/ghostex/gxClient.ts` (`createSession` / `sendSessionText` / `focusSession`) | already tested |

`GhostexSessionProxy` is `vscode`-free and both ports are injected (the Ghostex
client and the transcript source), so it is unit-tested in plain Node — no live
gxserver, no editor runtime.

### Key design points

- **A proxy pane is a plain terminal session** (`createSession`), never
  `createAgentSession`. Spawning a Ghostex-hosted agent *is the D4a model*; D4b
  deliberately avoids it — the process already exists, owned by gas-city.
- **Append-only mirroring.** A Ghostex pane can only be appended to via
  `sendSessionText`, while the gas-city source replaces the whole transcript on
  every change. `paneAppend` diffs the two: it appends the new suffix in the
  common case, and re-renders behind a divider when the transcript diverges (an
  edited turn). Bursts coalesce to the latest snapshot; a send failure is soft and
  re-sends on the next snapshot.
- **Attach = `focusSession`.** Revealing the pane brings it to front in Ghostex —
  the "attachable" half of the acceptance criteria.

### How to use it

`Ghostex: Proxy gas-city Session…` (command palette, or the title button on the
Ghostex **Sessions** view): pick a gas-city city + session, pick a Ghostex
project to host the pane, and the live transcript begins mirroring into a focused
Ghostex pane.

## Parity comparison: D4a vs D4b

| Dimension | D4a — Ghostex hosts | D4b — gas-city hosts (this branch) |
|---|---|---|
| **Process owner** | Ghostex (spawned by `gx create-agent`) | gas-city supervisor (a polecat/crew/mayor session) |
| **Where you drive it** | Cockpit chat panel → gxserver | gas-city (its native owner); Ghostex is read/attach |
| **Ghostex surface** | a hosted agent pane | a proxy terminal pane mirroring the transcript |
| **Direction of data** | Ghostex → Cockpit | gas-city → Ghostex |
| **Input path** | Cockpit → `sendSessionMessage` to Ghostex | gas-city's own submit path (unchanged) |
| **Output path** | `readSessionText` re-read on gxserver events | `ConversationStore` stream → `sendSessionText` |
| **Tool-approvals / permission mode** | none through the bridge (flat buffer) | preserved — handled in gas-city, where the agent lives |
| **Lifecycle owner** | Ghostex (sleep/wake/kill in Ghostex) | gas-city (the proxy pane is disposable scaffolding) |
| **Reuses** | new `GhostexConversationStore` | existing `ConversationStore` (no new conversation core) |
| **Failure blast radius** | a Ghostex crash takes the agent | a Ghostex crash drops only the *view*; the agent runs on |

### Trade-offs to decide on

- **Pick D4a (hosted)** if Ghostex should be the primary place agents *live* and
  are driven — a "bidirectional/peer" model where the Cockpit is one of several
  front-ends to a Ghostex-owned process.
- **Pick D4b (proxied)** if gas-city remains the authoritative supervisor and
  Ghostex is an *observability/attach* surface — agents keep all their gas-city
  affordances (permission modes, tool-approvals, the refinery/witness lifecycle),
  and Ghostex never becomes a single point of failure for a running agent.
- **Or support both per-dispatch (D4 option c):** the two cores are independent
  and compose — a dispatch could choose `hosted` or `proxied` per agent.

The recommendation embedded in D4 favors the hosted/peer intent (D4a); D4b exists
so that choice is made against a working alternative rather than in the abstract.
