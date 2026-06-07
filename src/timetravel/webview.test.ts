import { describe, expect, it } from 'vitest';
import { escapeHtml, renderTimeTravelHtml } from './webview';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" attr='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; attr=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('renderTimeTravelHtml', () => {
  const html = renderTimeTravelHtml({ nonce: 'NONCE123', cspSource: 'vscode-resource://abc', title: 'Event Time-Travel' });

  it('locks scripts to the nonce and sets a strict CSP', () => {
    expect(html).toContain('<script nonce="NONCE123">');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
    expect(html).toContain("style-src vscode-resource://abc 'unsafe-inline'");
  });

  it('wires the webview bridge and announces itself ready', () => {
    expect(html).toContain('acquireVsCodeApi()');
    expect(html).toContain("{ type: 'ready' }");
  });

  it('renders the scrubber transport and event list', () => {
    expect(html).toContain('id="scrub"');
    expect(html).toContain('type="range"');
    expect(html).toContain('id="play"');
    expect(html).toContain('id="to-live"');
    expect(html).toContain('id="speed"');
    expect(html).toContain('id="events"');
    expect(html).toContain('id="empty"');
  });

  it('handles the timeline + append messages and copy/jump transport', () => {
    expect(html).toContain("msg.type === 'timeline'");
    expect(html).toContain("msg.type === 'append'");
    expect(html).toContain("type: 'copy'");
  });

  it('offers a save-scenario control that asks the host to capture the replay', () => {
    expect(html).toContain('id="save-scenario"');
    expect(html).toContain('aria-label="Save replay as regression scenario"');
    expect(html).toContain("type: 'saveScenario'");
  });

  it('escapes the title in the document', () => {
    const evil = renderTimeTravelHtml({ nonce: 'n', cspSource: 's', title: '<script>evil</script>' });
    expect(evil).not.toContain('<script>evil</script>');
    expect(evil).toContain('&lt;script&gt;evil&lt;/script&gt;');
  });

  it('renders server text via textContent, never innerHTML', () => {
    // The client builds list rows with createElement + textContent so event
    // fields can never inject markup; assert no innerHTML sink slipped in.
    expect(html).toContain('.textContent =');
    expect(html).not.toContain('.innerHTML');
  });

  it('marks live regions and labels the controls for screen readers', () => {
    expect(html).toContain('id="status" role="status" aria-live="polite"');
    expect(html).toContain('aria-label="Event timeline scrubber"');
    expect(html).toContain('aria-label="Recorded events"');
    expect(html).toContain('aria-valuetext');
  });

  it('keeps controls themed in light/dark and bordered in high contrast', () => {
    expect(html).toContain(':root { color-scheme: light dark; }');
    expect(html).toContain('var(--vscode-button-border, var(--vscode-contrastBorder, transparent))');
    expect(html).toContain(':focus-visible { outline: 2px solid var(--vscode-focusBorder)');
  });
});
