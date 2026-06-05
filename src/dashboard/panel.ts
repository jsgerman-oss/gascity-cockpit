// VS Code glue for the projected dashboard tab.
//
// Intentionally thin (PRD: the editor-bound layer is kept small and excluded
// from heavy unit testing). It owns a single webview panel, renders the shell
// (embed.ts) or the configure placeholder, and binds the host bridge (bridge.ts)
// to `webview.postMessage` / `onDidReceiveMessage`. All the logic worth testing
// lives behind `./bridge`, `./embed`, `./config`, and `./protocol`.
import * as vscode from "vscode";
import { DEFAULT_SUPERVISOR_BASE_URL, type ApiEndpoint, type Logger } from "../discovery/index.ts";
import { DashboardBridge, buildConfig } from "./bridge";
import { buildTheme, resolveDashboardUrl } from "./config";
import {
  SHELL_OPEN_SETTINGS,
  buildPlaceholderHtml,
  buildWebviewHtml,
  createNonce,
} from "./embed";
import { EMBED_CHANNEL, type DashboardApiAccess, type NativeTarget } from "./protocol";

const VIEW_TYPE = "gascityCockpit.dashboard";
const PANEL_TITLE = "GasCity Dashboard";
const DASHBOARD_URL_SETTING = "gascityCockpit.dashboard.url";

/** Host context the panel reads/acts through. The extension supplies live getters. */
export interface DashboardPanelDeps {
  /** Resolve the configured dashboard URL (raw setting value). */
  readDashboardUrl(): string;
  /** The currently-resolved API endpoint, or null when disconnected. */
  readEndpoint(): ApiEndpoint | null;
  /** Currently-selected city, when one is selected (forthcoming city switcher). */
  readCity?(): string | undefined;
  /** Structured logger (the extension's output channel). */
  log: Logger;
  /** Open a native Cockpit surface the dashboard deep-linked to (forthcoming surfaces). */
  onNavigateNative?(target: NativeTarget): void;
}

/** Map a resolved API endpoint to the tokenized access handed to the dashboard. */
function apiAccessFrom(endpoint: ApiEndpoint | null): DashboardApiAccess {
  if (!endpoint) return { baseUrl: DEFAULT_SUPERVISOR_BASE_URL, token: null };
  return { baseUrl: endpoint.baseUrl, token: endpoint.token };
}

/** The active VS Code theme as the contract's coarse theme (kind + name). */
function currentTheme() {
  const name = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
  return buildTheme(vscode.window.activeColorTheme.kind, name);
}

/**
 * Singleton webview panel that projects the dashboard. `show` creates it or
 * reveals the existing one; the panel re-renders on demand and pushes API/theme
 * updates to the embedded dashboard over the bridge.
 */
export class DashboardPanel {
  private static instance: DashboardPanel | undefined;

  /** The live panel, or undefined when none is open. */
  static get current(): DashboardPanel | undefined {
    return DashboardPanel.instance;
  }

  /** Create the dashboard panel, or reveal it if already open. */
  static show(deps: DashboardPanelDeps): DashboardPanel {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal();
      return DashboardPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // The shell loads no local resources — it only frames the remote dashboard.
        localResourceRoots: [],
      },
    );
    DashboardPanel.instance = new DashboardPanel(panel, deps);
    return DashboardPanel.instance;
  }

  private readonly bridge: DashboardBridge;
  private readonly disposables: vscode.Disposable[] = [];
  /** Origin of the currently-projected dashboard, or null while showing the placeholder. */
  private frameOrigin: string | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: DashboardPanelDeps,
  ) {
    this.bridge = new DashboardBridge({
      post: (message) => {
        void this.panel.webview.postMessage(message);
      },
      handlers: {
        onReady: (protocol) => this.handleReady(protocol),
        onNavigateNative: (target) => this.handleNavigateNative(target),
        onOpenExternal: (url) => this.handleOpenExternal(url),
        onRouteChanged: (route) => this.deps.log("debug", "dashboard route changed", { route }),
        onError: (message, detail) =>
          this.deps.log("warn", `dashboard error: ${message}`, detail ? { detail } : undefined),
      },
      log: this.deps.log,
    });

    this.panel.webview.onDidReceiveMessage(
      (raw) => this.handleMessage(raw),
      undefined,
      this.disposables,
    );
    // Keep the projected dashboard skinned to the editor theme.
    vscode.window.onDidChangeActiveColorTheme(
      () => {
        if (this.frameOrigin) this.bridge.sendTheme(currentTheme());
      },
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    this.render();
  }

  /** Re-render the shell/placeholder from the current setting (call on config change). */
  render(): void {
    const resolution = resolveDashboardUrl(this.deps.readDashboardUrl());
    const webview = this.panel.webview;
    const nonce = createNonce();
    if (resolution.status === "ok") {
      this.frameOrigin = resolution.origin;
      webview.html = buildWebviewHtml({
        dashboardUrl: resolution.url,
        frameOrigin: resolution.origin,
        nonce,
        cspSource: webview.cspSource,
        title: PANEL_TITLE,
      });
      this.deps.log("info", `projecting dashboard ${resolution.url}`);
      return;
    }
    this.frameOrigin = null;
    const message =
      resolution.status === "unset"
        ? "No dashboard URL is configured yet. Set one to project the gascity dashboard into this tab."
        : "The configured dashboard URL is invalid.";
    const detail = resolution.status === "invalid" ? resolution.reason : `Setting: ${DASHBOARD_URL_SETTING}`;
    webview.html = buildPlaceholderHtml({ nonce, cspSource: webview.cspSource, message, detail });
    this.deps.log(resolution.status === "invalid" ? "warn" : "info", `dashboard not projected: ${detail}`);
  }

  /** Push the latest resolved API endpoint/token to the dashboard (reconnect, city switch). */
  refreshApi(): void {
    if (this.frameOrigin) this.bridge.setApi(apiAccessFrom(this.deps.readEndpoint()));
  }

  private handleMessage(raw: unknown): void {
    // Shell control (placeholder "Open Settings" button) — not part of the contract.
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw as { channel?: unknown }).channel === EMBED_CHANNEL &&
      (raw as { type?: unknown }).type === SHELL_OPEN_SETTINGS
    ) {
      void vscode.commands.executeCommand("workbench.action.openSettings", DASHBOARD_URL_SETTING);
      return;
    }
    this.bridge.receive(raw);
  }

  private handleReady(protocol: number): void {
    this.deps.log("info", `dashboard ready (embed protocol ${protocol}) — sending config`);
    const city = this.deps.readCity?.();
    const config = buildConfig({
      api: apiAccessFrom(this.deps.readEndpoint()),
      theme: currentTheme(),
      ...(city ? { city } : {}),
    });
    this.bridge.sendConfig(config);
  }

  private handleNavigateNative(target: NativeTarget): void {
    if (this.deps.onNavigateNative) {
      this.deps.onNavigateNative(target);
    } else {
      // Native surfaces (beads tree, agents view) are forthcoming; log until then.
      this.deps.log("info", `dashboard requested native ${target.kind} ${target.id} (no handler yet)`);
    }
  }

  private handleOpenExternal(url: string): void {
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(url, true);
    } catch {
      this.deps.log("warn", `dashboard open-external: not a valid URI: ${url}`);
      return;
    }
    if (parsed.scheme !== "http" && parsed.scheme !== "https") {
      this.deps.log("warn", `dashboard open-external: refusing non-http(s) URI: ${url}`);
      return;
    }
    void vscode.env.openExternal(parsed);
  }

  /** Reveal the panel (bring its tab to the foreground). */
  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    DashboardPanel.instance = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
