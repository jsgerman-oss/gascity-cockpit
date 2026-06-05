// The Cockpit webview shell that PROJECTS the dashboard.
//
// VS Code gives us a webview whose HTML we fully control; we render a locked-down
// shell that frames the configurable dashboard URL and runs a small, origin-pinned
// relay bridging the extension host and the embedded dashboard (the embed.ts side
// of the contract in protocol.ts). Security posture:
//
//   - A strict CSP (`default-src 'none'`) that frames ONLY the dashboard origin
//     and runs ONLY our nonce-locked bootstrap script.
//   - The API token is NEVER placed in the iframe URL (it would leak via Referer,
//     history, and logs); it is delivered later over the postMessage bridge.
//   - The relay pins the dashboard origin both ways: it forwards to the dashboard
//     with an explicit target origin (never "*") and only accepts dashboard->host
//     messages whose `event.origin` matches.
//
// The HTML builders are pure (string in, string out) so they are unit-tested in
// plain Node (PRD Testing Decisions, Seam 2) — no `vscode` import here.
import { randomBytes } from "node:crypto";
import {
  DASHBOARD_READY,
  EMBED_CHANNEL,
  EMBED_PROTOCOL_VERSION,
  HOST_THEME,
  THEME_TOKENS,
} from "./protocol";

/**
 * Shell control message (NOT part of the dashboard contract): the configure
 * placeholder asks the host to open the dashboard-URL setting. Kept here so the
 * dashboard-facing protocol stays clean.
 */
export const SHELL_OPEN_SETTINGS = "shell/open-settings";

/** A cryptographically-random nonce for the CSP `script-src`. New per webview load. */
export function createNonce(): string {
  return randomBytes(16).toString("hex");
}

export interface CspOptions {
  /** Per-load nonce locking the bootstrap script. */
  nonce: string;
  /** `webview.cspSource` — the origin VS Code serves webview resources from. */
  cspSource: string;
  /** Dashboard origin allowed in `frame-src`, or null/absent to frame nothing. */
  frameOrigin?: string | null;
}

/**
 * Build the webview Content-Security-Policy. `default-src 'none'` denies by
 * default; we then admit only what the shell needs. Note: we deliberately do NOT
 * add a nonce/hash to `style-src` — doing so makes browsers ignore
 * `'unsafe-inline'`, which would block VS Code's own injected theme `<style>`.
 */
export function buildContentSecurityPolicy(opts: CspOptions): string {
  const frame = opts.frameOrigin ? opts.frameOrigin : "'none'";
  return [
    "default-src 'none'",
    `frame-src ${frame}`,
    `style-src ${opts.cspSource} 'unsafe-inline'`,
    `img-src ${opts.cspSource} data:`,
    `font-src ${opts.cspSource}`,
    `script-src 'nonce-${opts.nonce}'`,
  ].join("; ");
}

/** Escape a value for safe interpolation into an HTML attribute (double-quoted). */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a value for safe interpolation into HTML text. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Serialize a value for embedding inside a `<script>` JSON island. JSON is not
 * HTML, so a literal `</script>` or `<!--` in a string would break out of the
 * element; escaping `<` to its unicode form is the standard mitigation.
 */
function jsonIsland(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Config the bootstrap relay reads from the JSON island (single-sources protocol constants). */
interface ShellConfig {
  channel: string;
  protocol: number;
  frameOrigin: string;
  themeTokens: readonly string[];
  hostThemeType: string;
  dashboardReadyType: string;
}

/**
 * The origin-pinned relay that runs inside the shell. Static (it reads everything
 * from the `#gc-embed-config` JSON island), so it carries the nonce and nothing
 * dynamic is interpolated into executable code.
 *
 *   - host -> dashboard: messages from the VS Code host (event.source !== frame)
 *     are forwarded into the iframe with the dashboard origin pinned as target.
 *   - dashboard -> host: messages from the iframe are accepted only when
 *     event.origin matches the dashboard origin, then posted to the host.
 *   - theme: only the shell can read VS Code's resolved `--vscode-*` variables
 *     (the dashboard is a separate document), so it snapshots a curated set and
 *     pushes `host/theme` on load, on `dashboard/ready`, and whenever the editor
 *     theme changes.
 */
const RELAY_BOOTSTRAP = `(function () {
  var vscode = acquireVsCodeApi();
  var cfg = JSON.parse(document.getElementById('gc-embed-config').textContent);
  var frame = document.getElementById('gc-dashboard');
  var ORIGIN = cfg.frameOrigin;

  function themeKind() {
    var c = document.body.classList;
    if (c.contains('vscode-high-contrast-light')) return 'high-contrast-light';
    if (c.contains('vscode-high-contrast')) return 'high-contrast';
    if (c.contains('vscode-light')) return 'light';
    return 'dark';
  }
  function readTokens() {
    var style = getComputedStyle(document.documentElement);
    var out = {};
    for (var i = 0; i < cfg.themeTokens.length; i++) {
      var name = cfg.themeTokens[i];
      var v = style.getPropertyValue('--vscode-' + name).trim();
      if (v) out[name] = v;
    }
    return out;
  }
  function pushTheme() {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage({
      channel: cfg.channel, protocol: cfg.protocol, type: cfg.hostThemeType,
      theme: { kind: themeKind(), tokens: readTokens() }
    }, ORIGIN);
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.channel !== cfg.channel) return;
    if (event.source === frame.contentWindow) {
      if (event.origin !== ORIGIN) return;                 // origin pin: only the dashboard
      vscode.postMessage(data);                            // dashboard -> host
      if (data.type === cfg.dashboardReadyType) pushTheme();
    } else {
      if (frame.contentWindow) frame.contentWindow.postMessage(data, ORIGIN); // host -> dashboard
    }
  });

  // VS Code mutates body theme classes and the :root --vscode-* variables live.
  var observer = new MutationObserver(pushTheme);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  frame.addEventListener('load', pushTheme);
}());`;

export interface WebviewHtmlOptions {
  /** The validated dashboard URL to frame. */
  dashboardUrl: string;
  /** Origin of `dashboardUrl`, for CSP `frame-src` and postMessage target pinning. */
  frameOrigin: string;
  /** Per-load nonce locking the bootstrap script. */
  nonce: string;
  /** `webview.cspSource`. */
  cspSource: string;
  /** Protocol version to stamp on shell-originated messages. Defaults to current. */
  protocol?: number;
  /** Accessible document title. */
  title?: string;
}

/** Render the projecting shell: a full-bleed iframe of the dashboard plus the relay. */
export function buildWebviewHtml(opts: WebviewHtmlOptions): string {
  const protocol = opts.protocol ?? EMBED_PROTOCOL_VERSION;
  const csp = buildContentSecurityPolicy({
    nonce: opts.nonce,
    cspSource: opts.cspSource,
    frameOrigin: opts.frameOrigin,
  });
  const shellConfig: ShellConfig = {
    channel: EMBED_CHANNEL,
    protocol,
    frameOrigin: opts.frameOrigin,
    themeTokens: THEME_TOKENS,
    hostThemeType: HOST_THEME,
    dashboardReadyType: DASHBOARD_READY,
  };
  const title = escapeHtml(opts.title ?? "GasCity Dashboard");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background); }
    #gc-dashboard { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  </style>
</head>
<body>
  <iframe
    id="gc-dashboard"
    title="${title}"
    src="${escapeAttribute(opts.dashboardUrl)}"
    referrerpolicy="no-referrer"
    allow="clipboard-read; clipboard-write"
  ></iframe>
  <script type="application/json" id="gc-embed-config" nonce="${opts.nonce}">${jsonIsland(shellConfig)}</script>
  <script nonce="${opts.nonce}">${RELAY_BOOTSTRAP}</script>
</body>
</html>`;
}

export interface PlaceholderHtmlOptions {
  /** Per-load nonce locking the placeholder's button script. */
  nonce: string;
  /** `webview.cspSource`. */
  cspSource: string;
  /** Why the dashboard is not shown (e.g. URL unset, URL invalid). */
  message: string;
  /** Optional secondary hint. */
  detail?: string;
  /** Label for the settings button. */
  actionLabel?: string;
}

/**
 * Render the "dashboard not configured / invalid" placeholder shown when there is
 * no usable dashboard URL. Frames nothing (`frame-src 'none'`); its button asks
 * the host (via {@link SHELL_OPEN_SETTINGS}) to open the dashboard-URL setting.
 */
export function buildPlaceholderHtml(opts: PlaceholderHtmlOptions): string {
  const csp = buildContentSecurityPolicy({
    nonce: opts.nonce,
    cspSource: opts.cspSource,
    frameOrigin: null,
  });
  const message = escapeHtml(opts.message);
  const detail = opts.detail ? `<p class="detail">${escapeHtml(opts.detail)}</p>` : "";
  const actionLabel = escapeHtml(opts.actionLabel ?? "Open Settings");
  const openSettings = jsonIsland({ channel: EMBED_CHANNEL, type: SHELL_OPEN_SETTINGS });
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GasCity Dashboard</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex; align-items: center; justify-content: center;
      height: 100vh; margin: 0; padding: 0 2rem; box-sizing: border-box;
    }
    .empty { max-width: 32rem; text-align: center; }
    .empty h2 { font-weight: 600; margin: 0 0 0.5rem; }
    .empty p { color: var(--vscode-descriptionForeground); line-height: 1.5; margin: 0 0 1rem; }
    .empty .detail { font-size: 0.9em; }
    button {
      font-family: inherit; font-size: inherit; cursor: pointer;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-background); border-radius: 2px; padding: 0.4rem 1rem;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="empty">
    <h2>GasCity Dashboard</h2>
    <p>${message}</p>
    ${detail}
    <button id="gc-configure">${actionLabel}</button>
  </div>
  <script type="application/json" id="gc-open-settings" nonce="${opts.nonce}">${openSettings}</script>
  <script nonce="${opts.nonce}">(function () {
    var vscode = acquireVsCodeApi();
    var msg = JSON.parse(document.getElementById('gc-open-settings').textContent);
    document.getElementById('gc-configure').addEventListener('click', function () { vscode.postMessage(msg); });
  }());</script>
</body>
</html>`;
}
