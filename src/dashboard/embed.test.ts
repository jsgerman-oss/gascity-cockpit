import { describe, expect, it } from "vitest";
import {
  SHELL_OPEN_SETTINGS,
  buildContentSecurityPolicy,
  buildPlaceholderHtml,
  buildWebviewHtml,
  createNonce,
} from "./embed";
import { EMBED_CHANNEL, HOST_THEME } from "./protocol";

const CSP_SOURCE = "vscode-webview://abc";
const ORIGIN = "http://127.0.0.1:5173";

describe("createNonce", () => {
  it("is a 32-char hex string, unique per call", () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("buildContentSecurityPolicy", () => {
  it("denies by default and frames only the dashboard origin", () => {
    const csp = buildContentSecurityPolicy({ nonce: "N", cspSource: CSP_SOURCE, frameOrigin: ORIGIN });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`frame-src ${ORIGIN}`);
  });

  it("locks scripts to the nonce but does NOT nonce styles (so VS Code's inline theme styles still apply)", () => {
    const csp = buildContentSecurityPolicy({ nonce: "N123", cspSource: CSP_SOURCE, frameOrigin: ORIGIN });
    expect(csp).toContain("script-src 'nonce-N123'");
    expect(csp).toContain(`style-src ${CSP_SOURCE} 'unsafe-inline'`);
    // The style directive must not carry a nonce (it would disable 'unsafe-inline').
    expect(csp).not.toMatch(/style-src[^;]*nonce/);
  });

  it("frames nothing when no origin is given (placeholder)", () => {
    const csp = buildContentSecurityPolicy({ nonce: "N", cspSource: CSP_SOURCE, frameOrigin: null });
    expect(csp).toContain("frame-src 'none'");
  });
});

describe("buildWebviewHtml", () => {
  const html = buildWebviewHtml({
    dashboardUrl: `${ORIGIN}/app`,
    frameOrigin: ORIGIN,
    nonce: "NONCE",
    cspSource: CSP_SOURCE,
  });

  it("frames the dashboard URL and embeds the CSP", () => {
    expect(html).toContain(`src="${ORIGIN}/app"`);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain(`frame-src ${ORIGIN}`);
  });

  it("wires the nonce into both script tags", () => {
    expect(html).toContain('id="gc-embed-config" nonce="NONCE"');
    expect(html.match(/nonce="NONCE"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("ships the protocol constants to the relay via the JSON island", () => {
    expect(html).toContain(`"frameOrigin":"${ORIGIN}"`);
    expect(html).toContain(`"channel":"${EMBED_CHANNEL}"`);
    expect(html).toContain(`"hostThemeType":"${HOST_THEME}"`);
  });

  it("pins the dashboard origin both ways in the relay", () => {
    // Inbound: only accept dashboard-origin messages.
    expect(html).toContain("event.origin !== ORIGIN");
    // Outbound: post into the frame with the origin as target, never '*'.
    expect(html).toContain("frame.contentWindow.postMessage(data, ORIGIN)");
  });

  it("never places a token in the iframe URL", () => {
    // The token travels over the postMessage bridge, not the framed URL (it must
    // not leak via Referer/history/logs). The iframe src is exactly the input URL.
    expect(html).toContain(`src="${ORIGIN}/app"`);
    expect(html).not.toMatch(/token=/i);
    expect(html).not.toMatch(/authorization/i);
  });

  it("escapes a hostile URL so it cannot break out of the src attribute", () => {
    const hostile = buildWebviewHtml({
      dashboardUrl: `${ORIGIN}/a"><script>alert(1)</script>`,
      frameOrigin: ORIGIN,
      nonce: "N",
      cspSource: CSP_SOURCE,
    });
    expect(hostile).not.toContain('"><script>alert(1)</script>');
    expect(hostile).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("buildPlaceholderHtml", () => {
  const html = buildPlaceholderHtml({
    nonce: "N",
    cspSource: CSP_SOURCE,
    message: "No dashboard URL configured.",
    detail: "Set gascityCockpit.dashboard.url",
  });

  it("frames nothing and shows the message + detail", () => {
    expect(html).toContain("frame-src 'none'");
    expect(html).toContain("No dashboard URL configured.");
    expect(html).toContain("Set gascityCockpit.dashboard.url");
  });

  it("wires the open-settings shell control into the button", () => {
    expect(html).toContain(`"type":"${SHELL_OPEN_SETTINGS}"`);
    expect(html).toContain(`"channel":"${EMBED_CHANNEL}"`);
    expect(html).toContain('id="gc-configure"');
  });
});
