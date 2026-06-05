# GasCity Cockpit — PRD

A VS Code extension (the client) plus a thin enabling gascity pack (the city-side
contract): an adaptive, multi-tab cockpit inside the editor for monitoring and
driving your gas cities, built entirely on the existing gascity `/v0` HTTP API.

## Problem Statement

As an operator of one or more gas cities, I drive the whole fleet from a terminal:
`gc` for status, `gc bd` for beads, `gc mail` / `gc session nudge` to talk to agents,
`gc dolt` / `gc doctor` for health, and a separate static web dashboard for at-a-glance
monitoring. The code my agents are working on lives in polecat worktrees I have to find
by hand. Talking to the Mayor (or any agent) is fire-and-forget nudging or threaded
mail — there is no interactive, in-context conversation, and when an agent pauses for a
tool-approval or asks me a question I only see it if I am attached to the right tmux
pane. My context is scattered across terminal, browser dashboard, and editor. I want one
adaptive surface, in the editor where I already read the code, that shows me the state of
my cities and lets me act on them.

## Solution

"GasCity Cockpit" — a VS Code extension that turns the editor into an adaptive, multi-tab
cockpit for your gas cities, plus a thin gascity pack that makes a city Cockpit-ready. The
Cockpit is a client of the gascity `/v0` HTTP API served by the running supervisor — the
same API the web dashboard already uses. It provides:

- Live status panes (city health, agents, sessions, event feed) updating in real time over SSE.
- A Beads explorer across all your cities: open / ready / closed with rich status and
  dependency graphs; create, update, assign, dispatch, and close beads without leaving the editor.
- Interactive chat with the Mayor (and any agent): a structured conversation panel backed by
  the session transcript / submit / stream API, including interrupting the autonomous loop and
  answering tool-approval / input prompts natively in VS Code.
- Code / worktree navigation: jump from a bead to the polecat worktree and diff for the work in flight.
- TDD and workflow affordances: preview/run formulas (e.g. the `tdd` formula) and watch their runs.
- Dashboard projection: embed ("project") the forthcoming new gascity dashboard directly as a Cockpit
  tab, so the full dashboard experience lives inside the editor without the extension rebuilding it.

The expensive part already exists: a versioned, self-documenting (`/openapi.json`) HTTP API with
SSE streaming and a complete session/chat/approval surface. The Cockpit is a well-built client;
the pack is the city-side enabler.

## User Stories

Monitoring / status
1. As an operator, I want a live city-health pane in VS Code, so that I can see at a glance whether my city is healthy without running `gc doctor`.
2. As an operator, I want to see all my registered cities and switch between them, so that I can manage a fleet from one place.
3. As an operator, I want a live event feed over SSE, so that I can watch what my agents are doing in real time.
4. As an operator, I want to see every agent/session and its state (active, draining, asleep), so that I can tell who is working and who is idle.
5. As an operator, I want unread-mail and health badges in the status bar, so that I notice problems without opening a panel.
6. As an operator, I want storage/health warnings (e.g. Dolt size, events.jsonl) surfaced visually, so that I can act before they cross hard thresholds.

Beads
7. As an operator, I want a Beads explorer tree of all beads across my cities, so that I can see the whole backlog in one view.
8. As an operator, I want to filter/group beads by status, rig, assignee, type, and priority, so that I can focus on what matters.
9. As an operator, I want to see open, ready, in-progress, and closed beads with rich status, so that I understand the state of work.
10. As an operator, I want to open a bead and see its full detail (description, deps, comments, metadata, history), so that I have context.
11. As an operator, I want to visualize a bead's dependency graph, so that I can see what is blocking what.
12. As an operator, I want to create a new bead from the editor (type, priority, description), so that I can capture work without switching tools.
13. As an operator, I want to update, assign, close, and reopen beads from the Cockpit, so that I can manage work in place.
14. As an operator, I want to dispatch a bead to a polecat pool (sling) from the Cockpit, so that I can route work with one action.
15. As an operator, I want to add/remove dependencies between beads visually, so that I can structure work correctly.

Chat / agents
16. As an operator, I want an interactive chat panel with the Mayor, so that I can ask questions and give instructions conversationally.
17. As an operator, I want the chat to stream the response as it is produced, so that it feels responsive.
18. As an operator, I want the full conversation transcript with roles, so that I have the history of what was said.
19. As an operator, I want to chat with any agent (deacon, a polecat, a witness), so that I can coordinate the whole fleet.
20. As an operator, I want to interrupt an agent mid-task (`interrupt_now`), so that I can redirect it without waiting.
21. As an operator, I want to send a follow-up that queues behind the current turn (`follow_up`), so that I do not disrupt in-flight work.
22. As an operator, I want a throwaway "Ask" side-conversation that does not disturb the agent's autonomous loop, so that I can get a quick answer safely.
23. As an operator, when an agent pauses for a tool-approval, I want to see it in VS Code and approve/deny inline, so that I do not have to attach to a terminal pane.
24. As an operator, when an agent asks me a question (prompt-for-input), I want to answer it from the Cockpit, so that the agent can continue.
25. As an operator, I want to set an agent's permission mode from the Cockpit, so that I can control how much it asks.
26. As an operator, I want pending approvals across all sessions aggregated in one place, so that nothing blocks unseen.

Code / worktree
27. As an operator, I want to jump from a bead to the polecat worktree where it is being worked, so that I can read the code in context.
28. As an operator, I want to see the diff for the work on a bead, so that I can review progress.
29. As an operator, I want code navigation to be read-only for agent worktrees, so that I never corrupt an agent sandbox.

Workflows / TDD
30. As an operator, I want to preview and run a formula from the Cockpit, so that I can trigger workflows visually.
31. As an operator, I want to kick off a TDD flow on a bead and watch its runs, so that I can drive test-first work.
32. As an operator, I want to create and watch a convoy of related beads, so that I can manage batch work.

Cross-cutting
33. As an operator, I want the Cockpit to auto-discover the running supervisor API, so that I do not configure URLs by hand.
34. As an operator, I want the Cockpit to degrade gracefully and reconnect when the API/supervisor restarts or the city is stopped, so that it stays usable across lifecycle events.
35. As an operator, I want the Cockpit to work with multiple cities at once, so that I can run a fleet.
36. As an operator with a Cockpit-ready pack installed, I want the city to advertise itself to the extension, so that setup is one step.
37. As an operator, I want the Cockpit to follow VS Code theming and accessibility, so that it feels native.

Dashboard projection
38. As an operator, I want the Cockpit to project the new gascity dashboard as a tab, so that I get the full dashboard experience inside the editor without a separate browser and without the extension rebuilding it.
39. As an operator, I want the projected dashboard to share my Cockpit's selected city, auth, and theme, so that it feels like one integrated surface rather than an iframe bolted on.
40. As an operator, I want to deep-link from a Cockpit bead/agent into the matching view of the projected dashboard, so that native surfaces and the dashboard stay in sync.

## Implementation Decisions

- Two artifacts: (1) the "GasCity Cockpit" VS Code extension (client), distributed via the VS
  Code Marketplace / .vsix; (2) a thin gascity pack (city-side enabler) that turns on the API
  service, registers the Cockpit as an extmsg adapter, ships any Mayor "IDE-affordance" skills,
  and declares the `/v0` API version it requires.
- The extension is a pure client of the existing gascity `/v0` HTTP API served by the
  supervisor; the extension introduces no new long-running backend of its own.
- Generate a typed TypeScript client from the live `/openapi.json` (huma-generated). This is the
  single source of truth for request/response shapes and pins the API version.
- Native VS Code surfaces for tree (Beads explorer, cities/agents/sessions), chat, approvals, and
  code navigation; Webview panels for rich status/charts.
- Dashboard projection: the forthcoming new gascity dashboard is embedded ("projected") into a
  Cockpit webview tab rather than reimplemented. This requires an embed contract co-designed with the
  new-dashboard effort: webview/iframe-friendly CSP and framing, tokenized API access passed from the
  extension host, VS Code theme-variable sync, deep-link/route control (open the dashboard at a given
  city/view), and a host↔webview message bridge so dashboard actions can call back into the extension.
  Projecting is strongly preferred over rebuilding charts (see open decision 2).
- Real-time updates over existing SSE streams (`/events/stream`, `/agent/{id}/output/stream`,
  `/session/{id}/stream`). Responsive chat uses the async pattern already in the API: `submit`
  returns `{request_id, event_cursor}`; the client streams events filtered to that `request_id`
  from `event_cursor` to avoid replaying backlog.
- Chat is built on the structured transcript model (`format: "conversation"`, `turns:[{role,text}]`),
  `submit` with `intent ∈ {default, follow_up, interrupt_now}`, the pending/respond surface
  (`pending.kind ∈ {tool-approval, prompt-for-input}`, `respond`), and `permission-mode`.
- Beads operations map directly to existing endpoints (list / ready / get / graph / update / close /
  reopen / assign / deps); dispatch uses the existing sling / `gc.routed_to` semantics.
- Discovery + resilience is a defined contract. Today there is no api-address file (the API was
  found on 127.0.0.1:8372 by inspection); the pack will publish a discovery handshake the extension
  consumes, and the extension implements reconnect/backoff and an explicit "API unavailable" state.

Open design decisions (recorded; to be resolved before the phases they gate):
1. Conversation model: drive the live autonomous session (with `interrupt_now`) vs. dedicated
   side-sessions — recommendation: support both (a "Console" attached to the live session and
   throwaway "Ask" sessions).
2. Reuse vs. rebuild vs. project the frontend: hybrid — OpenAPI client + native surfaces for
   tree/chat/approvals/code, and PROJECT the new gascity dashboard into a webview tab rather than
   rebuilding its charts. Decide the split between native surfaces and the projected dashboard, and
   pin the embed contract (auth/CSP/theme/deep-link/message-bridge) with the new-dashboard effort.
3. What the "pack" ships and how the extension is delivered and handshakes with a city.
4. Discovery contract + API-down / supervisor-restart UX.
5. Identity & approval authority: who you are when chatting/approving from VS Code, what you may
   approve, how it maps to the extmsg participant/auth model; auth decided before any remote story.
6. Tool-call / rich-content fidelity: how tool calls, code blocks, diffs, and streaming partials are
   represented in `turns[].text` for rich rendering.
7. Scope boundary vs. the existing Claude Code VS Code extension: a fleet/city cockpit, not a code
   assistant — complement, do not duplicate.

## Testing Decisions

- Good tests assert external behavior, not implementation details.
- Seam 1 (preferred, highest): the typed API-client + domain store layer, tested against an
  OpenAPI-conformant mock `/v0` server. Covers beads list/CRUD, session submit/stream/transcript,
  pending/respond, health/events. Provider-agnostic and stable.
- Seam 2: the Webview ↔ extension-host message protocol (postMessage contract) tested in isolation —
  given host→webview state the panel renders/acts; given webview→host actions the host calls the
  right client method. Keeps UI logic testable without a real editor.
- Seam 3 (integration, thin): a small set of live-contract tests against a running supervisor API on
  a throwaway test city, mirroring gascity's existing `test/integration/*_live_contract_test.go`
  style — assert the `/v0` shapes the Cockpit depends on have not drifted.
- Prior art: gascity's `internal/api` huma handler tests, `test/integration/*_live_contract_test.go`,
  and the `internal/sessionlog` reader tests for transcript normalization.
- The VS Code-API-bound glue (tree providers, command registration) is kept thin and excluded from
  heavy unit testing; behavior lives behind the testable client/store seam.

## Out of Scope

- Remote / multi-machine access and the associated auth/tunneling (localhost-only for v1; auth model
  designed but full remote deferred).
- Replacing or rebuilding the web dashboard. The Cockpit complements it and PROJECTS the new gascity
  dashboard into a tab; building dashboard visualizations from scratch is out of scope.
- Replacing the Claude Code code-assistant VS Code extension (different purpose).
- Editing agent worktrees from the Cockpit (read-only code navigation in v1).
- Changes to the `/v0` API itself beyond the discovery handshake and (optionally) extmsg adapter
  registration; API gaps found are filed against gastown, not built here.
- Mobile / non-VS-Code editors.

## Further Notes

- Feasibility is de-risked: the transcript-fidelity spike (the biggest unknown) is GREEN — the API
  returns structured, provider-normalized conversation JSON, supports interrupt, native
  tool-approval, and async request correlation, and is self-documenting for client codegen.
- Risk: the `/v0` surface is on a moving dev build; the generated client must pin/declare the version
  and the pack must assert compatibility.
- A dedicated rig/repo should be created for the extension + pack when build starts; until then this
  epic (in HQ beads) is the canonical home for the PRD.
- Lifecycle awareness matters: stopping a city (`gc stop`) takes the API down with it; the Cockpit
  must treat API availability as transient and reconnect.
- A new gascity dashboard is in flight. The Cockpit will PROJECT it into a webview tab rather than
  rebuild it, so we must coordinate early with that effort to ensure it is embeddable: webview-safe
  CSP/framing, tokenized API access, theme-variable theming, and deep-linkable routes. Track its
  readiness as an external dependency; until it ships, the Cockpit falls back to native status panes.
