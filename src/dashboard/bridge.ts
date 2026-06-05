// Host side of the dashboard embed bridge.
//
// The bridge is the testable seam between the extension host and the projected
// dashboard (PRD Testing Decisions, Seam 2): given host state it builds the
// outbound messages to push to the dashboard, and given an inbound webview
// message it validates, narrows, and dispatches it to typed handlers. It is
// provider-agnostic — `post` and the handlers are injected — so the panel glue
// (panel.ts) supplies `webview.postMessage` and the VS Code-specific actions,
// while this logic is unit-tested in plain Node.
import {
  DASHBOARD_ERROR,
  DASHBOARD_NAVIGATE_NATIVE,
  DASHBOARD_OPEN_EXTERNAL,
  DASHBOARD_READY,
  DASHBOARD_ROUTE_CHANGED,
  EMBED_CHANNEL,
  EMBED_PROTOCOL_VERSION,
  HOST_API,
  HOST_CONFIG,
  HOST_NAVIGATE,
  HOST_THEME,
  parseDashboardMessage,
  type DashboardApiAccess,
  type DashboardCapabilities,
  type DashboardConfig,
  type DashboardMessage,
  type DashboardRoute,
  type DashboardTheme,
  type HostApiMessage,
  type HostConfigMessage,
  type HostMessage,
  type HostNavigateMessage,
  type HostThemeMessage,
  type NativeTarget,
} from "./protocol";

// --- Outbound message builders (pure) ---------------------------------------

/** Build a `host/config` message (full initial configuration). */
export function configMessage(config: DashboardConfig): HostConfigMessage {
  return { channel: EMBED_CHANNEL, protocol: config.protocol, type: HOST_CONFIG, config };
}

/** Build a `host/theme` message (theme changed). */
export function themeMessage(
  theme: DashboardTheme,
  protocol: number = EMBED_PROTOCOL_VERSION,
): HostThemeMessage {
  return { channel: EMBED_CHANNEL, protocol, type: HOST_THEME, theme };
}

/** Build a `host/navigate` message (deep-link the dashboard to a route). */
export function navigateMessage(
  route: DashboardRoute,
  protocol: number = EMBED_PROTOCOL_VERSION,
): HostNavigateMessage {
  return { channel: EMBED_CHANNEL, protocol, type: HOST_NAVIGATE, route };
}

/** Build a `host/api` message (resolved API endpoint/token changed). */
export function apiMessage(
  api: DashboardApiAccess,
  protocol: number = EMBED_PROTOCOL_VERSION,
): HostApiMessage {
  return { channel: EMBED_CHANNEL, protocol, type: HOST_API, api };
}

/** Default host capabilities advertised to the dashboard. */
export const DEFAULT_CAPABILITIES: DashboardCapabilities = {
  canOpenNative: true,
  canOpenExternal: true,
};

/** Parts the panel assembles into a {@link DashboardConfig}. */
export interface BuildConfigInput {
  api: DashboardApiAccess;
  theme: DashboardTheme;
  city?: string;
  route?: DashboardRoute;
  capabilities?: DashboardCapabilities;
  protocol?: number;
}

/** Assemble a {@link DashboardConfig}, filling protocol + capabilities defaults. */
export function buildConfig(input: BuildConfigInput): DashboardConfig {
  const config: DashboardConfig = {
    protocol: input.protocol ?? EMBED_PROTOCOL_VERSION,
    api: input.api,
    theme: input.theme,
    capabilities: input.capabilities ?? DEFAULT_CAPABILITIES,
  };
  if (input.city) config.city = input.city;
  if (input.route) config.route = input.route;
  return config;
}

// --- Inbound dispatch --------------------------------------------------------

export type BridgeLogLevel = "debug" | "info" | "warn" | "error";
/** Minimal logger compatible with the extension's `Logger` (extra args ignored). */
export type BridgeLogger = (level: BridgeLogLevel, message: string) => void;

/** Typed callbacks the panel supplies for dashboard->host actions. */
export interface DashboardHandlers {
  /** Dashboard finished booting and is ready for config; arg is its protocol version. */
  onReady?(protocol: number): void;
  /** Dashboard asked to open a native Cockpit surface (bead/agent/…). */
  onNavigateNative?(target: NativeTarget): void;
  /** Dashboard asked the host to open a URL in the system browser. */
  onOpenExternal?(url: string): void;
  /** Dashboard's internal route changed; host may mirror/persist it. */
  onRouteChanged?(route: DashboardRoute): void;
  /** Dashboard reported an error. */
  onError?(message: string, detail?: string): void;
}

export interface DashboardBridgeDeps {
  /** Send a host->dashboard message (panel wires this to `webview.postMessage`). */
  post(message: HostMessage): void;
  /** Handlers for inbound dashboard->host messages. */
  handlers?: DashboardHandlers;
  /** Optional logger for dropped/mismatched messages. */
  log?: BridgeLogger;
}

/**
 * Host-side bridge to one projected dashboard. Holds no editor resources (the
 * panel owns the webview and its listeners), so it needs no disposal — it is a
 * pure translator between host state and the embed protocol.
 */
export class DashboardBridge {
  private readonly post: (message: HostMessage) => void;
  private readonly handlers: DashboardHandlers;
  private readonly log?: BridgeLogger;

  constructor(deps: DashboardBridgeDeps) {
    this.post = deps.post;
    this.handlers = deps.handlers ?? {};
    this.log = deps.log;
  }

  /** Push the full initial configuration to the dashboard. */
  sendConfig(config: DashboardConfig): void {
    this.post(configMessage(config));
  }

  /** Push a theme change to the dashboard. */
  sendTheme(theme: DashboardTheme): void {
    this.post(themeMessage(theme));
  }

  /** Deep-link the dashboard to a route. */
  navigate(route: DashboardRoute): void {
    this.post(navigateMessage(route));
  }

  /** Push a changed API endpoint/token to the dashboard (reconnect, city switch). */
  setApi(api: DashboardApiAccess): void {
    this.post(apiMessage(api));
  }

  /**
   * Validate, narrow, and dispatch an inbound webview message. Unknown or
   * malformed messages are dropped (and logged at debug), never acted on.
   * Returns the parsed message, or null when it was dropped.
   */
  receive(raw: unknown): DashboardMessage | null {
    const msg = parseDashboardMessage(raw);
    if (!msg) {
      this.log?.("debug", "dashboard bridge: dropping unrecognised webview message");
      return null;
    }
    switch (msg.type) {
      case DASHBOARD_READY:
        if (msg.protocol !== EMBED_PROTOCOL_VERSION) {
          this.log?.(
            "warn",
            `dashboard bridge: dashboard speaks embed protocol ${msg.protocol}, host speaks ${EMBED_PROTOCOL_VERSION}`,
          );
        }
        this.handlers.onReady?.(msg.protocol);
        break;
      case DASHBOARD_NAVIGATE_NATIVE:
        this.handlers.onNavigateNative?.(msg.target);
        break;
      case DASHBOARD_OPEN_EXTERNAL:
        this.handlers.onOpenExternal?.(msg.url);
        break;
      case DASHBOARD_ROUTE_CHANGED:
        this.handlers.onRouteChanged?.(msg.route);
        break;
      case DASHBOARD_ERROR:
        this.handlers.onError?.(msg.message, msg.detail);
        break;
    }
    return msg;
  }
}
