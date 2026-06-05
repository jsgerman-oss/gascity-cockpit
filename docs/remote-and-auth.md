# Remote Access & Auth Story

> Status: **v1 is localhost-only by design.** This document records that stance,
> the seams already in place for a future remote/authenticated deployment, and
> what is deliberately **not** built yet. No remote-auth code ships in v1 — the
> point here is that none of it has to be retrofitted; the hooks already exist.

The Cockpit is a pure client of the gascity `/v0` HTTP API (see
[API Discovery & Resilience](./api-discovery-and-resilience.md)). This document
answers a single question operators and reviewers keep asking: *can I point the
Cockpit at a supervisor on another machine, and how does it authenticate?*

## The v1 stance: localhost only

**v1 targets a supervisor reachable on the local machine.** The documented
default endpoint is `http://127.0.0.1:8372` (loopback), and the supervisor binds
loopback. There is no transport security (TLS) and no identity exchange beyond an
optional shared bearer token. Concretely, v1 assumes:

- The API is on `127.0.0.1` (or another host the operator has *already* made
  reachable and trusted — e.g. an SSH tunnel they manage outside the Cockpit).
- Anyone who can reach the port is authorized. On a single-user workstation that
  is the OS boundary; the loopback bind is the security control.
- Auth, if present at all, is a single static bearer token shared out-of-band.

This is a deliberate scoping decision, not an oversight. Building remote auth
(TLS, token issuance/rotation, per-user identity, CORS/origin policy on the
server) is a cross-cutting effort spanning the supervisor, the dashboard, and the
Cockpit. v1 ships the localhost experience and leaves clean seams rather than
shipping a half-built remote story.

### Why not remote auth now

- **The server side isn't there.** The supervisor binds loopback and has no
  remote auth/identity surface to integrate against. A Cockpit-only "remote auth"
  would have nothing to talk to.
- **Tokens in v1 are coarse.** The bearer token is a single shared secret applied
  to the whole API (see below) — fine as a loopback convenience, not a remote
  authorization model.
- **Scope honesty.** Half-built auth invites misuse (operators trusting a
  transport that isn't actually secured). Localhost-only is a property we can
  state plainly and verify.

## Seams already in place

Everything a remote/auth story would need to hook into already exists and is
tested. None of it is localhost-specific in shape — only the *defaults* and the
*absence of a remote producer* are.

### 1. Endpoint configuration — `src/discovery`

The API base URL is resolved by a documented precedence chain in
[`resolveEndpoint`](../src/discovery/discovery.ts), each rung accepted only after
a live `/health` probe:

| Rung | Source | Setting / file | Notes |
|------|--------|----------------|-------|
| 1 | settings override | `gascityCockpit.api.url` | Highest priority. **Already accepts any URL**, including a non-loopback host. |
| 2 | discovery descriptor | `~/.gc/api.json`, then `<city>/.gc/runtime/api.json` | Producer-side emission is a supervisor responsibility, not yet implemented. |
| 3 | documented default | `http://127.0.0.1:8372` | The loopback supervisor. |

The override rung means a future remote deployment needs **no new endpoint
plumbing** — point `gascityCockpit.api.url` at the remote base URL and discovery
already probes and adopts it. (It will work today over a transport the operator
has secured themselves, e.g. an SSH tunnel; what's missing is *Cockpit-managed*
security, not the ability to target a URL.)

### 2. Token threading — `src/discovery` → `src/api`

A bearer token flows end-to-end already:

- **Source:** `gascityCockpit.api.token` setting (read in
  [`buildDiscoveryInputs`](../src/host/host.ts)) or a `token` field on a discovery
  descriptor ([`parseDescriptor`](../src/discovery/descriptor.ts)).
- **Carried on the endpoint:** `ApiEndpoint.token` (`src/discovery/types.ts`).
- **Built into a header in one place:** [`bearerAuthHeader`](../src/api/client.ts)
  is the single seam that turns a token into `Authorization: Bearer <token>` (or
  nothing, on the unauthenticated path).
- **Applied everywhere through that seam:** the host's client factory
  ([`createClient`](../src/host/host.ts)) threads `bearerAuthHeader` into every
  `createCockpitClient` it builds (beads, approvals, formulas, extmsg, the
  connection check). The surfaces that construct their own client or stream — the
  chat panel (`src/chat/open-chat.ts`), the per-session / city SSE readers
  (`src/api/session-stream.ts`), and the live Fleet/event stream wiring
  (`src/features/status.feature.ts`) — call the same helper. The discovery-layer
  `/health` probe (`src/discovery/health.ts`) carries the same token independently,
  keeping discovery free of an `src/api` dependency.

So the auth *transport* (a bearer header on every `/v0` request) is wired, and it
funnels through a single construction point. What a remote story would add is the
auth *model* behind that token: issuance, scope, rotation, expiry, and a server
that enforces them.

### 3. Dashboard projection keeps the token off the wire — `src/dashboard`

The projected dashboard tab ([embed contract](./dashboard-embed-contract.md))
already treats the token as a secret: it is **never** placed in the iframe URL
(which would leak via `Referer`, history, and logs) and is instead delivered over
the origin-pinned `postMessage` bridge. A remote deployment inherits that posture
unchanged.

## What a future remote/auth effort would touch

This is a map for later, not a v1 deliverable:

1. **Transport security.** TLS to the supervisor (or a documented tunnel
   requirement). The Cockpit's `fetch`-based client already speaks `https`; the
   gap is server-side.
2. **A real token model.** Replace the single shared `api.token` with issued,
   scoped, expiring credentials. The injection point (`bearerAuthHeader` in
   `src/api`) and the storage seam (settings / descriptor) stay; their *contents*
   and lifecycle change. VS Code's `SecretStorage` would replace the plain
   `api.token` setting for anything sensitive.
3. **Origin / CORS policy.** A remote API must decide which origins (including the
   webview) may call it; today loopback sidesteps this.
4. **Descriptor producer.** Rung 2 of discovery is consumer-ready but has no
   producer; a remote deployment would emit descriptors with endpoint + token.

## For reviewers

If you are checking "does the Cockpit leak a remote attack surface in v1?": it
does not introduce one. It connects to a loopback default, accepts an
operator-supplied URL/token, and sends a bearer header when given one. It opens
no listening socket for inbound API traffic except the extmsg loopback callback
service (`src/extmsg`), which binds loopback for the local supervisor to reach.
Remote exposure is an operator choice (pointing `api.url` elsewhere over a
transport they secure), not a default.
