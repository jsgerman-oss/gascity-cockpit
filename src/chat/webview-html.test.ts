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
});
