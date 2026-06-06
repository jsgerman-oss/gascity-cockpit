# Companion Surfaces (web / mobile via `/v0`) — Scoping Spike

> Status: **SPIKE / scoping** for `cockpit-21l.9`. This is not a feature; it is
> the feasibility audit and the proposed **sub-epic** the bead asks for
> ("Large/exploratory — scope a spike first; likely its own sub-epic"). It ships
> one durable artifact — an enforced portability guard
> ([`src/test/core-portability.test.ts`](../src/test/core-portability.test.ts)) —
> and a ratifiable plan. It builds **no** companion app; that is the sub-epic.
>
> **Verdict: GREEN, with a clean split.** A **web** companion on localhost is
> buildable today on the existing shared core. A **mobile** companion (and any
> *remote* web companion) is gated on a cross-cutting **server-side** effort
> (CORS + real auth) that spans the supervisor and the dashboard, not just the
> Cockpit. Scope accordingly.

The premise of the bead: *because everything routes through `/v0` with a typed
client, a web or mobile companion can share that same client.* This spike checks
the premise against the actual code and finds it **true** — the expensive,
reusable half of the Cockpit is already `vscode`-free and browser-portable.

## What the companion is — and is NOT

A **companion surface** is a *non-VS-Code* client (a browser SPA today; a phone
later) that reuses the Cockpit's own typed `/v0` client and `vscode`-free domain
cores to present Cockpit-native surfaces — Fleet status, the Beads explorer, the
town-topology graph, the merge queue — outside the editor.

It is **not** the projected gascity dashboard. The PRD is explicit ("do not
rebuild the dashboard"): the forthcoming gascity **dashboard** is a *separate*
external app the Cockpit *frames* in a webview via the
[embed contract](./dashboard-embed-contract.md). The **companion** is the
opposite direction — it is built *from* the Cockpit's core, not framed *into* the
editor. Keeping these distinct matters: "web surface" is ambiguous, and
conflating them re-opens a settled scope decision.

| | Projected dashboard | Companion surface (this spike) |
|---|---|---|
| Built by | the separate new-dashboard effort | the Cockpit, from its own core |
| Relationship | Cockpit **frames** it (iframe in a webview) | Cockpit **is** it, minus the editor |
| Shares | a `postMessage` embed contract | the typed `/v0` client + domain cores |
| Lives | in a VS Code tab | in a browser / on a phone |

A real strategic question — *should these two converge?* — is an open fork below.

## Feasibility audit (the premise holds)

Every claim here was checked against the tree, not assumed.

### The typed client is already browser-portable

[`src/api/`](../src/api) is the single seam the whole Cockpit talks to `/v0`
through, and it is **100% free of `vscode` and of Node built-ins**. The runtime
client ([`createCockpitClient`](../src/api/client.ts)) is
[`openapi-fetch`](https://www.npmjs.com/package/openapi-fetch) over
`globalThis.fetch` — both are web-platform standard. The only runtime dependency
in `package.json` is `openapi-fetch`. A browser imports `src/api` unchanged.

### Real-time (SSE) is portable **and** auth-capable

The streaming layer ([`src/api/sse.ts`](../src/api/sse.ts),
[`session-stream.ts`](../src/api/session-stream.ts)) is built on **`fetch`
streaming** — `response.body` → `getReader()` → `TextDecoder` — *not* the browser
`EventSource`. This matters twice over:

- `ReadableStream` / `getReader` / `TextDecoder` are standard in every modern
  browser, so the live event feed, chat stream, and per-session streams run on
  the web as-is.
- `fetch` streaming **can set `Authorization` headers**; `EventSource` famously
  cannot. So the auth story does *not* hit the classic "can't authenticate an
  SSE stream from a browser" wall — the token threads onto the stream request
  exactly as it does on every other call ([`bearerAuthHeader`](../src/api/client.ts)).

### The domain cores are portable too

The behaviour-bearing logic — bead derivation/filtering/graphs, the live-status
model, the town-topology layout, merge-queue derivation, fleet-query parsing,
formula formatting, discovery, city presentation — lives in `vscode`-free cores
exported by ten barrels (`src/{api,beads,status,town,mergeQueue,fleet,formulas,discovery,cities,code}/index.ts`).
None imports `vscode`; none imports a Node built-in. The one core that binds the
host machine — [`src/extmsg/callback-server.ts`](../src/extmsg/callback-server.ts),
a loopback socket for the *local* supervisor to call back — is not part of the
companion surface and is not reachable from any of those barrels.

### Even the visualizations reuse

The expensive renderers are pure `data → string`. The town graph
([`renderTownSvg` / `renderTownWebviewHtml`](../src/town/render.ts)) and the bead
dependency graph ([`renderGraphSvg`](../src/beads/graph.ts)) emit themeable
**SVG/HTML strings** with class names only (colours cascade from a stylesheet).
A web companion injects the same SVG into the DOM; only the surrounding shell
differs.

### The reuse ratio

Roughly **86%** of the codebase is the portable core and **~14%** is editor
glue (≈19.3k vs ≈3.2k non-blank, non-comment lines — a rough proxy):

| Layer | Reuse on web/mobile |
|---|---|
| `src/api/**` (typed client, SSE) | **As-is** |
| `src/{beads,status,town,mergeQueue,fleet,formulas,discovery,cities,code}` cores | **As-is** (minus `status/views.ts`) |
| SVG/HTML string renderers | **As-is** (inject into DOM) |
| `src/views/**`, `src/features/**`, `src/host/**`, `src/chat/*panel*`, `src/status/views.ts` | **Rebuild** per surface (tree → list, webview panel → route, command → handler) |
| `src/extmsg/callback-server.ts`, `src/code/worktree.ts` git/fs side-effects | **N/A** (local-machine only) |

### This is now enforced, not just documented

The "vscode-free domain cores" guardrail was a *convention*
([contributing-features.md](./contributing-features.md)) with no test behind it.
This spike adds [`src/test/core-portability.test.ts`](../src/test/core-portability.test.ts):
it walks the transitive relative-import closure of the ten portable barrels and
fails `npm run check` if **any** reachable module imports `vscode` or a Node
built-in. So the companion's foundation cannot silently rot as features land —
the regression is caught at the offending PR, not when someone first tries to
build the companion. (The guard bites: injecting a `vscode` import into a core
file fails it with the exact file and specifier.)

## The gaps — what is *not* free

The premise (shared client) holds; these are the real costs the sub-epic owns.

1. **Server-side auth + transport (cross-cutting; gates mobile & remote web).**
   v1 is localhost-only by design ([remote-and-auth.md](./remote-and-auth.md)).
   The Cockpit's *seams* are wired (endpoint override accepts any URL; bearer
   token threads end-to-end), but the **server side does not exist**: no TLS, no
   issued/scoped/rotated tokens, no per-user identity. A phone is *never* on
   loopback, so **mobile cannot ship until this lands**. This spans the
   supervisor + dashboard + Cockpit — it is not a Cockpit-only deliverable.
2. **CORS / origin policy on `/v0` (gates *any* browser companion not same-origin).**
   A browser app served from its own origin calling the supervisor is a
   cross-origin request; the supervisor must send CORS headers (and decide
   allowed origins). Today loopback + same-process sidesteps this. **Server-side
   gap — file against gastown, not built here** (same family as the dashboard's
   `frame-ancestors` requirement).
3. **Discovery for off-machine.** The extension auto-discovers via
   `~/.gc/api.json` + the localhost default. A companion is not on the
   supervisor's machine, so it needs explicit endpoint config or the deferred
   descriptor *producer* (discovery rung 2 is consumer-ready, producer-absent).
4. **UI rebuild (the ~14%).** Tree providers, webview panels, and command
   registration are VS Code APIs; a companion rebuilds that glue against the DOM
   (web) or native components (mobile). The data, derivation, formatting, and SVG
   layers below it do not change.
5. **Identity & approval authority.** Who you *are* when approving a tool call
   from a phone, and what you may approve, ties to the extmsg participant model
   and the deferred auth model (PRD open decision 5). Read-only surfaces dodge
   this; write/approve surfaces do not.

## Reachability: today vs. gated

| Surface | Buildable now? | Blocked on |
|---|---|---|
| Web companion, **read-only**, served on **localhost** | **Yes** — shared core + CORS for the localhost origin | (2) localhost CORS only |
| Web companion, **write/chat/approve**, localhost | Mostly | (5) identity/approval authority |
| Web companion served **remotely** | No | (1) auth + TLS, (2) CORS, (3) discovery |
| **Mobile** companion (PWA or native), any network | No | (1) auth + TLS, (2) CORS, (3) discovery, (5) identity |

The honest headline: **the client reuse is done; the blockers are server-side and
cross-cutting.** A localhost web PoC is the cheapest way to prove the end-to-end
reuse and surface the CORS shape early.

## Proposed sub-epic (to ratify)

Bead-sized phases. The shape mirrors the parent epic's own enabler-first pattern
(`cockpit-1ll.15` unblocked the expansion features); here a shared-package
extraction unblocks the companion.

- **Phase 0 — Feasibility + portability guard.** *This spike.* Audit (above) +
  the enforced `core-portability` guard. **Done.**
- **Phase 1 — Core boundary + multi-target build (enabler).** Consolidate the
  portable surface behind one importable boundary the extension *and* sibling
  targets consume, and add the build wiring so a non-extension target compiles
  and runs. Landed in-repo as [`src/core` + a multi-target esbuild +
  stub CLI](./core-boundary.md) (`cockpit-dc8.4`) — pragmatically scoped *short*
  of the full npm-workspaces extraction below. Promoting `core` to a published
  `@cockpit/core` workspace package (one version, one CI, shared guard) is the
  remaining step if/when this repo becomes a monorepo; the import surface is
  already what such a package would expose. Pure addition, no extension
  behaviour change — like `cockpit-1ll.15`.
- **Phase 2 — Web companion MVP (localhost, read-only).** A minimal SPA on the
  shared core: Fleet/event feed (live over SSE), Beads explorer, town-topology
  SVG, merge queue. Reuses the renderers; rebuilds only the shell. Proves the
  reuse end-to-end in a browser and exercises the CORS requirement (2) concretely.
- **Phase 3 — Server-side enablers (filed against gastown).** `/v0` CORS/origin
  policy; the discovery descriptor producer; then the real token model + TLS.
  **External dependency**, tracked, not built in this repo. Gates everything below.
- **Phase 4 — Companion write surfaces.** Bead CRUD/dispatch, chat, and
  pending/approvals on the companion — gated on (5) identity and, for anything
  off-localhost, on Phase 3.
- **Phase 5 — Mobile.** PWA-first (the Phase-2 SPA made installable/responsive is
  the cheapest path and shares 100% of the code); native (React Native, sharing
  the TS core, rebuilding UI) only if a native shell is actually wanted. Gated on
  Phase 3.

Dependency order: **0 → 1 → 2** is reachable inside this repo now; **4** and **5**
wait on **3**, which is external.

## Open forks (to ratify)

1. **Monorepo vs. separate repo.** Extract `@cockpit/*` as workspaces *here*
   (one version, one CI, shared guard) or stand up a separate companion repo
   consuming a published core. *Assumption:* workspaces here — lowest friction,
   keeps the guard in one place.
2. **Web stack.** The house style is framework-free, string-templated HTML/SVG
   (esbuild, single runtime dep). A companion could continue that (reuse the SVG
   renderers directly, smallest bundle) or adopt a minimal framework for richer
   interaction. *Assumption:* framework-free or a thin lib; decide at Phase 2.
3. **Mobile strategy.** PWA (installable web, 100% code reuse) vs. React Native
   (native shell, shared TS core, rebuilt UI). *Assumption:* PWA-first.
4. **Convergence with the projected dashboard.** Is the companion ultimately the
   gascity dashboard *built on the Cockpit core*, making the embed contract and
   the companion two views of one app — or do they stay distinct? Strategic;
   coordinate with the new-dashboard effort before Phase 2 hardens.
5. **Who owns the server-side work (Phase 3).** CORS, descriptor producer, auth,
   TLS live in gastown/the supervisor, not the Cockpit. Confirm ownership and
   sequencing before promising any remote or mobile surface.

## Artifacts from this spike

| Artifact | Path |
|---|---|
| This scoping report | [`docs/companion-surfaces.md`](./companion-surfaces.md) |
| Enforced portability guard | [`src/test/core-portability.test.ts`](../src/test/core-portability.test.ts) |
| The portable surface it guards | `src/{api,beads,status,town,mergeQueue,fleet,formulas,discovery,cities,code}/index.ts` |
