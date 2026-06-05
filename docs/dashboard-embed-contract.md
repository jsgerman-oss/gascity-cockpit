# Dashboard Embed Contract

> Status: **PROPOSED** (implements PRD open decision #2 — "project, don't
> rebuild", and user stories 38–40). The **host/extension side is built and
> tested** (`src/dashboard/`): the CSP-locked webview shell, the origin-pinned
> relay, theme sync, tokenized API hand-off, and the host bridge. The
> **dashboard side is an external dependency** — the forthcoming gascity
> dashboard must conform to this contract to be projectable. Until it does, the
> Cockpit shows a configure placeholder and falls back to native panes.
> Assumptions are flagged in [Open forks](#open-forks-to-ratify).

This is how the Cockpit **projects** (embeds) the new gascity dashboard into a
VS Code webview tab *without rebuilding it*. The expensive dashboard UI already
exists (or soon will); the Cockpit is a thin, secure host around it that makes
it feel native — shared theme, shared auth, deep-linkable both ways.

## Why this exists

The PRD is explicit (Out of Scope): **do not rebuild the dashboard**. Instead we
frame it. But a naive `<iframe src=…>` is wrong on five counts, and each is a
clause of this contract:

1. **Framing must be safe.** The webview needs a strict CSP that frames *only*
   the dashboard's origin, and the dashboard server must permit being framed.
2. **Auth must not leak.** The API token cannot ride in the iframe URL (Referer,
   history, logs). It is delivered over `postMessage` after a handshake.
3. **It must feel native.** VS Code's theme lives in the *outer* webview document;
   the cross-origin dashboard does not inherit it, so theme is *sent*.
4. **It must be addressable.** The host can deep-link the dashboard to a city/view,
   and the dashboard can deep-link back into native Cockpit surfaces.
5. **It must talk back.** A host↔dashboard message bridge lets dashboard actions
   call into the extension (open a bead, open a browser).

## Topology

Three parties, two `postMessage` hops, one trust boundary:

```
┌─ extension host (Node) ─┐   webview.postMessage    ┌─ Cockpit shell (our HTML) ─┐   iframe.postMessage   ┌─ dashboard ─┐
│  DashboardPanel         │ ───────────────────────► │  origin-pinned relay       │ ─────────────────────► │  (forthcoming) │
│  DashboardBridge        │ ◄─────────────────────── │  (embed.ts bootstrap)      │ ◄───────────────────── │             │
└─────────────────────────┘  onDidReceiveMessage     └────────────────────────────┘   window 'message'     └─────────────┘
        trusted                                          trusted (we author it)            ── trust boundary ──
```

- **Extension host** — `src/dashboard/panel.ts` owns the webview; `bridge.ts`
  builds outbound messages and dispatches inbound ones to typed handlers.
- **Shell** — the HTML we generate (`embed.ts`). It frames the dashboard and runs
  a tiny relay that forwards messages each way, **pinning the dashboard origin**.
- **Dashboard** — the embedded app. Everything past the iframe boundary is
  untrusted; the host re-validates every inbound message (`parseDashboardMessage`).

The wire shape is defined once, provider-agnostically, in
[`src/dashboard/protocol.ts`](../src/dashboard/protocol.ts) — the single source
of truth both sides code against.

## Security model

| Concern | Mechanism |
|---------|-----------|
| Framing | CSP `default-src 'none'; frame-src <dashboard-origin>` — only the configured origin can be framed; everything else is denied. |
| Script injection | `script-src 'nonce-<per-load>'` — only our nonce-locked bootstrap runs. No `'unsafe-inline'` for scripts. |
| Theme styles | `style-src <cspSource> 'unsafe-inline'` **without** a nonce/hash — a nonce here would make browsers ignore `'unsafe-inline'` and block VS Code's own injected theme `<style>`. |
| Token leakage | The API token is **never** in the iframe URL. It is sent over the bridge in `host/config` / `host/api` after the dashboard signals `dashboard/ready`. |
| Cross-frame spoofing | The relay forwards to the dashboard with an explicit `targetOrigin` (never `"*"`), and accepts dashboard→host messages only when `event.origin` matches the dashboard origin and `event.source` is the iframe. |
| Untrusted input | The host treats every inbound message as hostile: `parseDashboardMessage` validates channel, protocol, type, and every field; unknown/malformed messages are dropped and logged, never acted on. |
| Referer | The iframe is `referrerpolicy="no-referrer"`. |

## The protocol

Every message is an envelope on a private channel, carrying a protocol version:

```jsonc
{ "channel": "gascity-cockpit/embed", "protocol": 1, "type": "<message-type>", ... }
```

`channel` lets each side ignore unrelated `postMessage` traffic (VS Code's own
webview channel, libraries, browser extensions). `protocol` is
`EMBED_PROTOCOL_VERSION` (currently **1**); both sides advertise the version they
speak so a mismatch is detectable, not silent. Bump it on any breaking change.

### Host → dashboard

| `type` | Payload | When |
|--------|---------|------|
| `host/config` | `{ config: DashboardConfig }` | Once, in response to `dashboard/ready`. Full initial state: API access, city, theme, route, host capabilities. |
| `host/theme` | `{ theme: DashboardTheme }` | The editor theme changed. Also (re)sent by the shell with high-fidelity `tokens` on load and on `dashboard/ready`. |
| `host/navigate` | `{ route: DashboardRoute }` | Deep-link the dashboard to a city/view. |
| `host/api` | `{ api: DashboardApiAccess }` | The resolved API endpoint/token changed (reconnect, supervisor restart, city switch). |

### Dashboard → host

| `type` | Payload | Effect |
|--------|---------|--------|
| `dashboard/ready` | — | Dashboard booted; host replies with `host/config`. **The dashboard MUST send this** to receive config. |
| `dashboard/navigate-native` | `{ target: NativeTarget }` | Host opens a native Cockpit surface (bead, agent, session, city, worktree). Forthcoming surfaces; logged until wired. |
| `dashboard/open-external` | `{ url }` | Host opens the URL in the system browser (http/https only). |
| `dashboard/route-changed` | `{ route: DashboardRoute }` | Dashboard's internal route changed; host may mirror/persist it. |
| `dashboard/error` | `{ message, detail? }` | Surface a dashboard-side error in the Cockpit log. |

### Payload shapes

```ts
type ThemeKind = "light" | "dark" | "high-contrast" | "high-contrast-light";

interface DashboardTheme {
  kind: ThemeKind;                    // coarse signal every dashboard can honour
  name?: string;                      // active VS Code theme label, when known
  tokens?: Record<string, string>;    // curated --vscode-* values (see THEME_TOKENS)
}

interface DashboardApiAccess {
  baseUrl: string;                    // supervisor base, no trailing slash
  token?: string | null;             // bearer for Authorization, or null/absent
}

interface DashboardRoute {            // dashboard-agnostic; dashboard interprets it
  city?: string; view?: string; path?: string; query?: Record<string, string>;
}

interface DashboardCapabilities { canOpenNative: boolean; canOpenExternal: boolean; }

interface DashboardConfig {
  protocol: number;
  api: DashboardApiAccess;
  city?: string;
  theme: DashboardTheme;
  route?: DashboardRoute;
  capabilities: DashboardCapabilities;
}

interface NativeTarget {
  kind: "bead" | "agent" | "session" | "city" | "worktree";
  id: string; city?: string;
}
```

`DashboardRoute` is deliberately open-ended — we do **not** enumerate dashboard
views, which would hard-code its internals. `city`/`view` are hints; `path`/`query`
are opaque to the host.

## Theme sync

Only the shell can read VS Code's resolved `--vscode-*` CSS variables (the
dashboard is a separate document). So:

- The **host** supplies the coarse `kind` + `name` it knows from the VS Code API
  (in `host/config` and on `onDidChangeActiveColorTheme`).
- The **shell** enriches with high-fidelity `tokens` — it snapshots a curated set
  (`THEME_TOKENS`, e.g. `editor-background`, `foreground`, `button-background`,
  `focusBorder`) from its own computed style and pushes `host/theme` on load, on
  `dashboard/ready`, and whenever VS Code mutates the theme (a `MutationObserver`).

The dashboard uses `kind` as the primary signal and applies `tokens` as CSS
variables for a native look.

## Tokenized API access

The dashboard calls `/v0` itself, using `DashboardApiAccess` from the host —
never a token baked into its URL. The host sources `baseUrl`/`token` from the
discovery layer (`ApiEndpoint`), so the dashboard rides the same auto-discovered,
auto-reconnecting endpoint as the rest of the Cockpit and gets `host/api` updates
when it changes. **Local-only for v1** (the discovery endpoint is localhost); a
remote auth story is deferred (PRD Out of Scope).

## Configuration

| Setting | Default | Meaning |
|---------|---------|---------|
| `gascityCockpit.dashboard.url` | `""` | URL of the dashboard to project. Empty → configure placeholder. Must be http(s). **No token in this URL.** |

Command **GasCity Cockpit: Open Dashboard** (`gascityCockpit.openDashboard`)
opens/reveals the tab.

## What a dashboard MUST do to be embeddable

This is the external-dependency checklist for the new-dashboard effort:

1. **Permit framing by the webview.** Do not send `X-Frame-Options: DENY`. Send a
   CSP `frame-ancestors` that allows the VS Code webview origin
   (`vscode-webview://*`) — or, pragmatically, be served such that the webview can
   frame it.
2. **Speak the protocol.** On load, `postMessage` `dashboard/ready` to
   `window.parent` (target origin = the webview origin from the received message).
   Listen for `host/config` / `host/theme` / `host/navigate` / `host/api`.
3. **Take auth from the bridge,** not the URL: read `config.api` and send
   `Authorization: Bearer <token>` yourself.
4. **Apply theme** from `config.theme` and subsequent `host/theme` messages.
5. **Ignore foreign messages** — filter on `channel === "gascity-cockpit/embed"`.
6. **(Optional)** emit `dashboard/navigate-native`, `dashboard/open-external`,
   `dashboard/route-changed`, `dashboard/error`.

## Open forks (to ratify)

1. **`frame-ancestors` exact value.** The host pins `frame-src` to the dashboard
   origin; the *reciprocal* (the dashboard allowing the webview origin) is the
   dashboard's to set. VS Code webview origins are opaque/rotating
   (`vscode-webview://<guid>`), so the dashboard likely needs a permissive
   `frame-ancestors vscode-webview:` (scheme-only) rather than an exact origin.
   **Assumption (open decision 2 unresolved):** dashboard allows `vscode-webview:`.
2. **Theme token set.** `THEME_TOKENS` is a curated, dashboard-agnostic subset.
   The new-dashboard effort may want more/fewer; the list is the negotiable
   surface, not the mechanism.
3. **Native deep-link vocabulary.** `NativeTarget.kind` covers the surfaces named
   in the PRD; extend as native panes land (cockpit-1ll.5/.6 and the chat work).
4. **Multi-dashboard / per-city URLs.** Today one configurable URL. A fleet may
   want a URL per city or a dashboard that self-routes via `host/navigate`'s
   `city`. Deferred until a real dashboard exists.

## Where the code lives

| Piece | File |
|-------|------|
| Wire protocol + guards (the contract) | `src/dashboard/protocol.ts` |
| CSP + webview shell + relay | `src/dashboard/embed.ts` |
| URL/theme resolution | `src/dashboard/config.ts` |
| Host bridge (build + dispatch) | `src/dashboard/bridge.ts` |
| VS Code panel glue | `src/dashboard/panel.ts` |
| Public surface | `src/dashboard/index.ts` |

Tests (PRD Testing Decisions, Seam 2) sit beside each module as `*.test.ts`.
