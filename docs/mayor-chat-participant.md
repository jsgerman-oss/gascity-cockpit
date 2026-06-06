# `@mayor` Chat Participant (VS Code native chat)

> Status: **BUILT** (`src/features/chatParticipant.feature.ts`,
> `src/chat/participant-bridge.ts`). Implements cockpit-dc8.2. Built on the
> `.15` feature registry (self-registering features + `sync:contributes` guard),
> the vscode-free chat `ConversationStore` (cockpit-1ll chat), and the typed
> `/v0` client (`src/api/`).

Puts the Mayor in **VS Code's own chat window** — the panel where Copilot lives.
Type `@mayor …` and the request is bridged to the active city's Mayor session
over the `/v0` API, streaming the reply back as markdown.

## Why this exists

The rich webview chat (the status-bar **Mayor** button / `openChat`) is the full
experience, but it is a separate panel. VS Code now has a first-class chat window
with `@`-mentionable participants; surfacing the Mayor there makes it reachable
from the same place developers already chat, with no panel to open.

One Mayor, two VS Code surfaces: the **webview chat** (rich — approvals,
permission modes, interrupts) and this **native participant** (lightweight,
always at hand). Both talk to the same Mayor session over the same API.

## Architecture

A provider-agnostic, `vscode`-free core (PRD Seam 1) with thin editor glue:

| Layer | File | Responsibility |
|-------|------|----------------|
| Turn core | `src/chat/participant-bridge.ts` | Drive one turn: submit, project the live stream into markdown deltas, detect completion / pending. No `vscode`. Unit-tested. |
| Session lifecycle | `src/chat/conversation-store.ts` (reused) | Loads the transcript, opens the per-session SSE stream, applies `turn`/`activity`/`pending` events into state. |
| Editor glue | `src/features/chatParticipant.feature.ts` | Registers the participant, resolves city/session, maps the `ChatResponseStream` onto a sink, renders the outcome. |
| Declaration | `src/features/chatParticipant.contributes.json` | `contributes.chatParticipants` — the `@mayor` name, icon, `/city` command. |

The bridge reuses `ConversationStore` for session lifecycle — the same store the
webview chat is built on. It forwards the prompt to
`POST /v0/city/{city}/session/{id}/submit`, then projects the per-session stream:
each `turn` snapshot yields an **append-only** assistant-text delta
(`AssistantDelta`), so the participant streams the reply rather than re-printing
it. The just-submitted prompt echoes back as a `user` turn and is filtered out.

**Completion** is event-driven (no timers, so a turn never hangs past the
request's cancellation token):

- Primary: an `in-turn → idle` activity transition. Because turns and activity
  arrive over the same ordered SSE stream, the final `turn` snapshot is already
  applied when `idle` lands.
- Backstop: the city-event outcome correlation
  (`awaitSubmitOutcome`) — covers providers that emit no activity, and surfaces
  server-side failures as an error.

## Markdown-only limitations vs the webview chat

The native chat UI renders markdown parts (`markdown`, `progress`, `button`); it
**cannot host the Cockpit's approval webview** or its permission/interrupt
controls. The consequences, and how this participant handles them:

| Capability | Webview chat | `@mayor` native participant |
|------------|--------------|------------------------------|
| Stream a reply | ✅ | ✅ markdown + `progress` |
| Tool-approval / prompt-for-input | ✅ inline, in the webview | ⚠️ **can't answer inline** — the turn stops, describes the prompt as markdown, and offers a **button that deep-links into the webview chat** (`openChat`) to approve there |
| Permission-mode toggle | ✅ | ❌ stays in the webview |
| Interrupt / follow-up intent | ✅ | ❌ each turn is a plain submit |
| Pick target session | ✅ session picker | Mayor only (the default chat target) |
| Pick target city | ✅ | ✅ `@mayor /city [name]` (sticky) |

The native chat API used here (`vscode.chat.createChatParticipant`, stable since
VS Code 1.90) has **no confirmation widget** — that remains a proposed API — so
interactive approvals are deliberately routed to the rich panel rather than
faked in markdown. When the Mayor needs one, you get a one-click hand-off.

## Usage

- `@mayor <prompt>` — talk to the Mayor in the active city (the workspace's city,
  else the first running city).
- `@mayor /city` — pick the target city from a QuickPick (sticky for later turns).
- `@mayor /city <name>` — switch directly to a named city.

## Graceful degradation

The chat API only exists on VS Code ≥ 1.90. On older editors the feature
no-ops at activation (`typeof vscode.chat?.createChatParticipant !== 'function'`)
and logs an info line; the rest of the Cockpit is unaffected.

## Testing

The turn lifecycle and the assistant-text projection live in the vscode-free
core and are unit-tested in `src/chat/participant-bridge.test.ts` against a fake
store (streaming deltas, in-turn→idle completion, the outcome backstop, pending
hand-off, submit failure, cancellation). The editor glue stays thin and
untested, per the feature contract (`docs/contributing-features.md`).
