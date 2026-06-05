// The GasCity Cockpit dashboard embed contract.
//
// This module is the single source of truth for the host<->webview message
// protocol used to PROJECT (embed) the forthcoming gascity dashboard into a
// Cockpit webview tab (PRD "Dashboard projection", user stories 38-40; open
// design decision 2). It deliberately stays dashboard-AGNOSTIC: it pins the
// wire shape both sides code against without assuming anything about the
// dashboard's internals (PRD Out of Scope: do NOT rebuild the dashboard).
//
// Three parties touch this protocol:
//   - the extension host (Node) via webview.postMessage / onDidReceiveMessage
//   - the Cockpit webview shell (browser) — an origin-pinned relay (see embed.ts)
//   - the embedded dashboard (browser) via window.postMessage
//
// It is provider-agnostic (no `vscode` import) so the contract and its guards
// are unit-tested in plain Node (PRD Testing Decisions, Seam 2).

/** Discriminator stamped on every embed message so each side can ignore unrelated
 *  postMessage traffic (VS Code's own webview channel, libraries, extensions). */
export const EMBED_CHANNEL = "gascity-cockpit/embed";

/** Embed protocol version. Bump on a breaking change to any message shape; both
 *  sides advertise the version they speak so a mismatch is detectable, not silent. */
export const EMBED_PROTOCOL_VERSION = 1;

// --- Message type tokens -----------------------------------------------------
// String constants (never inline the literals at call sites) keep the host, the
// shell relay, and the dashboard referring to one vocabulary.

/** Host -> dashboard: full initial configuration, sent once after `dashboard/ready`. */
export const HOST_CONFIG = "host/config";
/** Host -> dashboard: the editor theme changed; re-skin to match. */
export const HOST_THEME = "host/theme";
/** Host -> dashboard: deep-link the dashboard to a route (open at a city/view). */
export const HOST_NAVIGATE = "host/navigate";
/** Host -> dashboard: the resolved API endpoint/token changed (reconnect, city switch). */
export const HOST_API = "host/api";

/** Dashboard -> host: the dashboard booted and is ready to receive config. */
export const DASHBOARD_READY = "dashboard/ready";
/** Dashboard -> host: deep-link into a native Cockpit surface (open bead, reveal agent). */
export const DASHBOARD_NAVIGATE_NATIVE = "dashboard/navigate-native";
/** Dashboard -> host: ask the host to open a URL in the system browser. */
export const DASHBOARD_OPEN_EXTERNAL = "dashboard/open-external";
/** Dashboard -> host: the dashboard's internal route changed; host may mirror/persist it. */
export const DASHBOARD_ROUTE_CHANGED = "dashboard/route-changed";
/** Dashboard -> host: surface a dashboard-side error in the Cockpit log. */
export const DASHBOARD_ERROR = "dashboard/error";

// --- Shared payload shapes ---------------------------------------------------

/** Coarse editor appearance, mapped from VS Code's `ColorThemeKind`. The dashboard
 *  uses this as the primary signal and `tokens` for fidelity. */
export type ThemeKind = "light" | "dark" | "high-contrast" | "high-contrast-light";

/**
 * Editor theme snapshot forwarded to the dashboard. The embedded dashboard is a
 * separate (cross-origin) document, so it does NOT inherit VS Code's injected
 * `--vscode-*` CSS variables; the shell reads a curated set live and ships them
 * here so the dashboard can re-skin to feel native (PRD story 39).
 */
export interface DashboardTheme {
  /** light / dark / high-contrast — the coarse signal every dashboard can honour. */
  kind: ThemeKind;
  /** Active VS Code theme label (e.g. "Default Dark Modern"), when known. */
  name?: string;
  /** Curated `--vscode-*` token values (see {@link THEME_TOKENS}) for high-fidelity skinning. */
  tokens?: Record<string, string>;
}

/**
 * Curated set of VS Code theme variables the shell snapshots for the dashboard.
 * Names match VS Code's injected CSS custom properties (minus the `--vscode-`
 * prefix). Intentionally small and standard — a dashboard-agnostic palette, not
 * an exhaustive dump that would couple us to a VS Code version.
 */
export const THEME_TOKENS: readonly string[] = [
  "foreground",
  "editor-background",
  "editor-foreground",
  "font-family",
  "font-size",
  "focusBorder",
  "errorForeground",
  "descriptionForeground",
  "button-background",
  "button-foreground",
  "button-hoverBackground",
  "panel-border",
  "widget-border",
  "list-activeSelectionBackground",
  "list-hoverBackground",
  "textLink-foreground",
  "textLink-activeForeground",
  "badge-background",
  "badge-foreground",
];

/** Tokenized API access handed to the dashboard so it can call `/v0` itself. */
export interface DashboardApiAccess {
  /** Supervisor base URL, no trailing slash, e.g. "http://127.0.0.1:8372". */
  baseUrl: string;
  /** Bearer token for `Authorization`, or null/absent when unauthenticated. */
  token?: string | null;
}

/**
 * Dashboard-agnostic route descriptor for deep-linking. `city`/`view` are common
 * hints; `path`/`query` are opaque to the host and interpreted by the dashboard.
 * We intentionally do not enumerate dashboard views (would hard-code internals).
 */
export interface DashboardRoute {
  /** Target city name, when the route is city-scoped. */
  city?: string;
  /** Coarse view hint (e.g. "agents", "events") the dashboard maps to its own UI. */
  view?: string;
  /** Opaque in-app route path the dashboard understands. */
  path?: string;
  /** Opaque query parameters for the route. */
  query?: Record<string, string>;
}

/** What the host can do on the dashboard's behalf, so the dashboard can adapt its UI. */
export interface DashboardCapabilities {
  /** Host honours `dashboard/navigate-native` (deep-link into native surfaces). */
  canOpenNative: boolean;
  /** Host honours `dashboard/open-external` (open a URL in the system browser). */
  canOpenExternal: boolean;
}

/** Full configuration the host pushes to the dashboard after it signals ready. */
export interface DashboardConfig {
  /** Protocol version the host speaks. */
  protocol: number;
  /** Tokenized API access for direct `/v0` calls. */
  api: DashboardApiAccess;
  /** Currently-selected city, when one is selected. */
  city?: string;
  /** Initial theme snapshot. */
  theme: DashboardTheme;
  /** Initial route, when opening deep-linked. */
  route?: DashboardRoute;
  /** Host capabilities the dashboard may rely on. */
  capabilities: DashboardCapabilities;
}

/** A native Cockpit surface the dashboard wants the host to reveal. */
export interface NativeTarget {
  /** Which kind of native surface to open. */
  kind: "bead" | "agent" | "session" | "city" | "worktree";
  /** Identifier within that surface (bead id, agent id, …). */
  id: string;
  /** Owning city, when the target is city-scoped. */
  city?: string;
}

// --- Message unions ----------------------------------------------------------

/** Fields stamped on every embed message. */
export interface EmbedEnvelope {
  channel: typeof EMBED_CHANNEL;
  /** Protocol version of the sender. */
  protocol: number;
}

export interface HostConfigMessage extends EmbedEnvelope {
  type: typeof HOST_CONFIG;
  config: DashboardConfig;
}
export interface HostThemeMessage extends EmbedEnvelope {
  type: typeof HOST_THEME;
  theme: DashboardTheme;
}
export interface HostNavigateMessage extends EmbedEnvelope {
  type: typeof HOST_NAVIGATE;
  route: DashboardRoute;
}
export interface HostApiMessage extends EmbedEnvelope {
  type: typeof HOST_API;
  api: DashboardApiAccess;
}

/** Anything the host may send to the embedded dashboard. */
export type HostMessage = HostConfigMessage | HostThemeMessage | HostNavigateMessage | HostApiMessage;

export interface DashboardReadyMessage extends EmbedEnvelope {
  type: typeof DASHBOARD_READY;
}
export interface DashboardNavigateNativeMessage extends EmbedEnvelope {
  type: typeof DASHBOARD_NAVIGATE_NATIVE;
  target: NativeTarget;
}
export interface DashboardOpenExternalMessage extends EmbedEnvelope {
  type: typeof DASHBOARD_OPEN_EXTERNAL;
  url: string;
}
export interface DashboardRouteChangedMessage extends EmbedEnvelope {
  type: typeof DASHBOARD_ROUTE_CHANGED;
  route: DashboardRoute;
}
export interface DashboardErrorMessage extends EmbedEnvelope {
  type: typeof DASHBOARD_ERROR;
  message: string;
  detail?: string;
}

/** Anything the embedded dashboard may send back to the host. */
export type DashboardMessage =
  | DashboardReadyMessage
  | DashboardNavigateNativeMessage
  | DashboardOpenExternalMessage
  | DashboardRouteChangedMessage
  | DashboardErrorMessage;

/** Any message on the embed channel, in either direction. */
export type EmbedMessage = HostMessage | DashboardMessage;

// --- Validation --------------------------------------------------------------
// The host trusts neither the dashboard nor stray postMessage traffic: every
// inbound message is parsed and narrowed before use. Unknown/malformed messages
// return null and are dropped (logged by the bridge), never acted on.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return isObject(v) && Object.values(v).every(isString);
}

/** True when `v` is a well-formed embed envelope on our channel. */
export function isEmbedMessage(v: unknown): v is EmbedEnvelope & { type: string } {
  return (
    isObject(v) &&
    v.channel === EMBED_CHANNEL &&
    typeof v.protocol === "number" &&
    isNonEmptyString(v.type)
  );
}

function parseRoute(v: unknown): DashboardRoute | null {
  if (!isObject(v)) return null;
  const route: DashboardRoute = {};
  if (v.city !== undefined) {
    if (!isString(v.city)) return null;
    route.city = v.city;
  }
  if (v.view !== undefined) {
    if (!isString(v.view)) return null;
    route.view = v.view;
  }
  if (v.path !== undefined) {
    if (!isString(v.path)) return null;
    route.path = v.path;
  }
  if (v.query !== undefined) {
    if (!isStringRecord(v.query)) return null;
    route.query = v.query;
  }
  return route;
}

function parseNativeTarget(v: unknown): NativeTarget | null {
  if (!isObject(v) || !isNonEmptyString(v.id)) return null;
  const kinds: NativeTarget["kind"][] = ["bead", "agent", "session", "city", "worktree"];
  if (!isString(v.kind) || !kinds.includes(v.kind as NativeTarget["kind"])) return null;
  const target: NativeTarget = { kind: v.kind as NativeTarget["kind"], id: v.id };
  if (v.city !== undefined) {
    if (!isString(v.city)) return null;
    target.city = v.city;
  }
  return target;
}

/**
 * Validate and narrow a message the host received from the dashboard. Returns
 * the typed message, or null when it is not a recognised, well-formed
 * dashboard->host message (wrong channel, unknown type, missing fields).
 */
export function parseDashboardMessage(v: unknown): DashboardMessage | null {
  if (!isEmbedMessage(v)) return null;
  const protocol = v.protocol;
  const rec = v as unknown as Record<string, unknown>;
  switch (v.type) {
    case DASHBOARD_READY:
      return { channel: EMBED_CHANNEL, protocol, type: DASHBOARD_READY };
    case DASHBOARD_NAVIGATE_NATIVE: {
      const target = parseNativeTarget(rec.target);
      return target ? { channel: EMBED_CHANNEL, protocol, type: DASHBOARD_NAVIGATE_NATIVE, target } : null;
    }
    case DASHBOARD_OPEN_EXTERNAL: {
      const url = rec.url;
      return isNonEmptyString(url)
        ? { channel: EMBED_CHANNEL, protocol, type: DASHBOARD_OPEN_EXTERNAL, url }
        : null;
    }
    case DASHBOARD_ROUTE_CHANGED: {
      const route = parseRoute(rec.route);
      return route ? { channel: EMBED_CHANNEL, protocol, type: DASHBOARD_ROUTE_CHANGED, route } : null;
    }
    case DASHBOARD_ERROR: {
      if (!isNonEmptyString(rec.message)) return null;
      const msg: DashboardErrorMessage = {
        channel: EMBED_CHANNEL,
        protocol,
        type: DASHBOARD_ERROR,
        message: rec.message,
      };
      if (rec.detail !== undefined) {
        if (!isString(rec.detail)) return null;
        msg.detail = rec.detail;
      }
      return msg;
    }
    default:
      return null;
  }
}

/**
 * Validate and narrow a message the dashboard received from the host. Exported
 * so the embed contract is symmetric and the shell relay can validate before
 * forwarding (defense in depth); the dashboard implementation uses the same
 * logic on its side.
 */
export function parseHostMessage(v: unknown): HostMessage | null {
  if (!isEmbedMessage(v)) return null;
  const protocol = v.protocol;
  const rec = v as unknown as Record<string, unknown>;
  switch (v.type) {
    case HOST_CONFIG: {
      const config = parseConfig(rec.config);
      return config ? { channel: EMBED_CHANNEL, protocol, type: HOST_CONFIG, config } : null;
    }
    case HOST_THEME: {
      const theme = parseTheme(rec.theme);
      return theme ? { channel: EMBED_CHANNEL, protocol, type: HOST_THEME, theme } : null;
    }
    case HOST_NAVIGATE: {
      const route = parseRoute(rec.route);
      return route ? { channel: EMBED_CHANNEL, protocol, type: HOST_NAVIGATE, route } : null;
    }
    case HOST_API: {
      const api = parseApiAccess(rec.api);
      return api ? { channel: EMBED_CHANNEL, protocol, type: HOST_API, api } : null;
    }
    default:
      return null;
  }
}

const THEME_KINDS: readonly ThemeKind[] = ["light", "dark", "high-contrast", "high-contrast-light"];

function parseTheme(v: unknown): DashboardTheme | null {
  if (!isObject(v) || !isString(v.kind) || !THEME_KINDS.includes(v.kind as ThemeKind)) return null;
  const theme: DashboardTheme = { kind: v.kind as ThemeKind };
  if (v.name !== undefined) {
    if (!isString(v.name)) return null;
    theme.name = v.name;
  }
  if (v.tokens !== undefined) {
    if (!isStringRecord(v.tokens)) return null;
    theme.tokens = v.tokens;
  }
  return theme;
}

function parseApiAccess(v: unknown): DashboardApiAccess | null {
  if (!isObject(v) || !isNonEmptyString(v.baseUrl)) return null;
  const api: DashboardApiAccess = { baseUrl: v.baseUrl };
  if (v.token !== undefined) {
    if (v.token !== null && !isString(v.token)) return null;
    api.token = v.token;
  }
  return api;
}

function parseConfig(v: unknown): DashboardConfig | null {
  if (!isObject(v) || typeof v.protocol !== "number") return null;
  const api = parseApiAccess(v.api);
  const theme = parseTheme(v.theme);
  if (!api || !theme) return null;
  if (!isObject(v.capabilities)) return null;
  const caps = v.capabilities;
  if (typeof caps.canOpenNative !== "boolean" || typeof caps.canOpenExternal !== "boolean") return null;
  const config: DashboardConfig = {
    protocol: v.protocol,
    api,
    theme,
    capabilities: { canOpenNative: caps.canOpenNative, canOpenExternal: caps.canOpenExternal },
  };
  if (v.city !== undefined) {
    if (!isString(v.city)) return null;
    config.city = v.city;
  }
  if (v.route !== undefined) {
    const route = parseRoute(v.route);
    if (!route) return null;
    config.route = route;
  }
  return config;
}
