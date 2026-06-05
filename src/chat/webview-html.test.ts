import { describe, expect, it } from "vitest";
import { escapeHtml, getChatHtml } from "./webview-html.ts";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" attr='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; attr=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("getChatHtml", () => {
  const html = getChatHtml({ nonce: "NONCE123", cspSource: "vscode-resource://abc", title: "Mayor" });

  it("locks scripts to the nonce and sets a strict CSP", () => {
    expect(html).toContain(`<script nonce="NONCE123">`);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
    expect(html).toContain("style-src vscode-resource://abc 'unsafe-inline'");
  });

  it("wires the webview bridge and renders into a log container", () => {
    expect(html).toContain("acquireVsCodeApi()");
    expect(html).toContain("{ type: 'ready' }");
    expect(html).toContain('id="log"');
    expect(html).toContain('id="intent"');
  });

  it("escapes the title in the document", () => {
    const escaped = getChatHtml({ nonce: "n", cspSource: "s", title: "<script>evil</script>" });
    expect(escaped).not.toContain("<script>evil</script>");
    expect(escaped).toContain("&lt;script&gt;evil&lt;/script&gt;");
  });

  it("marks live regions so screen readers announce new turns, status, and approvals", () => {
    expect(html).toContain('role="log"');
    expect(html).toContain('id="log" role="log" aria-live="polite"');
    expect(html).toContain('id="status" role="status" aria-live="polite"');
    expect(html).toContain('id="pending" role="region"');
    expect(html).toMatch(/id="pending"[^>]*aria-live="polite"/);
  });

  it("labels the input controls and gives focus a theme-driven ring", () => {
    expect(html).toContain('aria-label="Message to the agent"');
    expect(html).toContain('aria-label="Submit intent"');
    expect(html).toContain(":focus-visible { outline: 2px solid var(--vscode-focusBorder)");
  });

  it("keeps controls themed in light/dark and bordered in high contrast", () => {
    // color-scheme lets the UA paint native control chrome for the active theme.
    expect(html).toContain(":root { color-scheme: light dark; }");
    // Buttons/selects fall back to contrastBorder (not transparent) so they keep
    // a visible edge under high-contrast themes, matching the dashboard placeholder.
    expect(html).toContain("var(--vscode-button-border, var(--vscode-contrastBorder, transparent))");
  });

  it("focuses the message box on load", () => {
    expect(html).toContain("els.input.focus()");
  });
});
