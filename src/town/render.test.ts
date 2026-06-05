import { describe, expect, it } from 'vitest';
import { buildTownGraph } from './topology';
import { layoutTown, renderTownSummary, renderTownSvg, renderTownWebviewHtml } from './render';
import { makeAgent, makeCity, makeHealth, makeState } from './fixtures';

/** A representative town: a mayor + a rig with a busy refinery and a suspended witness. */
function sampleState() {
  return makeState({
    health: makeHealth({ status: 'ok' }),
    cities: [makeCity({ name: 'blackrim-hq' })],
    agentsByCity: {
      'blackrim-hq': [
        makeAgent({ name: 'gastown.mayor', rig: undefined, running: true }),
        makeAgent({ name: 'gastown.refinery', rig: 'gascity-cockpit', running: true, available: true }),
        makeAgent({ name: 'gastown.witness', rig: 'gascity-cockpit', suspended: true }),
      ],
    },
  });
}

describe('layoutTown', () => {
  it('assigns a layer per hierarchy depth', () => {
    const layout = layoutTown(buildTownGraph(sampleState()));
    expect(layout.position.get('controller')!.level).toBe(0);
    expect(layout.position.get('city:blackrim-hq')!.level).toBe(1);
    expect(layout.position.get('agent:blackrim-hq/gastown.mayor')!.level).toBe(2);
    expect(layout.position.get('rig:blackrim-hq/gascity-cockpit')!.level).toBe(2);
    expect(layout.position.get('agent:blackrim-hq/gastown.refinery')!.level).toBe(3);
  });

  it('buckets every node into exactly one lane within its level', () => {
    const graph = buildTownGraph(sampleState());
    const layout = layoutTown(graph);
    const placed = layout.levels.flat();
    expect(placed.sort()).toEqual(graph.nodes.map((n) => n.id).sort());
  });
});

describe('renderTownSvg', () => {
  it('colours nodes by health and labels their role', () => {
    const svg = renderTownSvg(buildTownGraph(sampleState()));
    expect(svg).toContain('role="group"');
    expect(svg).toContain('gc-kind-controller');
    expect(svg).toContain('health-busy'); // the running refinery / mayor
    expect(svg).toContain('health-off'); // the suspended witness
    expect(svg).toContain('>REFINERY<');
    expect(svg).toContain('>WITNESS<');
    // a status dot is drawn per node
    expect(svg).toContain('class="gc-dot"');
  });

  it('draws an arrow-headed edge for each hierarchy link', () => {
    const graph = buildTownGraph(sampleState());
    const svg = renderTownSvg(graph);
    const edges = svg.match(/marker-end="url\(#gc-arrow\)"/g) ?? [];
    expect(edges).toHaveLength(graph.edges.length);
    expect(svg).toContain('<marker id="gc-arrow"');
  });

  it('puts the health word into each node aria-label', () => {
    const svg = renderTownSvg(buildTownGraph(sampleState()));
    expect(svg).toMatch(/aria-label="[^"]*offline[^"]*"/); // suspended witness
  });

  it('escapes special characters in labels', () => {
    const svg = renderTownSvg(
      buildTownGraph(
        makeState({
          cities: [makeCity({ name: 'a<b>&"' })],
          agentsByCity: {},
        }),
      ),
    );
    expect(svg).toContain('a&lt;b&gt;&amp;&quot;');
    expect(svg).not.toContain('a<b>&"');
  });

  it('still renders a single controller node when disconnected', () => {
    const svg = renderTownSvg(buildTownGraph(makeState({ health: null, cities: [], loading: false })));
    expect(svg).toContain('not connected');
    expect(svg).toContain('health-off');
  });
});

describe('renderTownSummary', () => {
  it('counts the layers and flags problems', () => {
    const state = makeState({
      cities: [makeCity({ name: 'blackrim-hq' })],
      agentsByCity: {
        'blackrim-hq': [
          makeAgent({ name: 'gastown.refinery', rig: 'r', running: true }),
          makeAgent({ name: 'gastown.witness', rig: 'r', available: false }), // warn
        ],
      },
    });
    const summary = renderTownSummary(buildTownGraph(state));
    expect(summary).toContain('1 city');
    expect(summary).toContain('1 rig');
    expect(summary).toContain('2 agents');
    expect(summary).toContain('Attention');
    expect(summary).toContain('gastown.witness (warning)');
  });

  it('reports a clean bill of health when nothing is wrong', () => {
    const summary = renderTownSummary(
      buildTownGraph(
        makeState({
          cities: [makeCity({ name: 'c' })],
          agentsByCity: { c: [makeAgent({ name: 'gastown.refinery', rig: 'r', running: true })] },
        }),
      ),
    );
    expect(summary).toContain('No warnings or errors');
  });
});

describe('renderTownWebviewHtml', () => {
  const html = renderTownWebviewHtml({ nonce: 'NONCE123', cspSource: 'vscode-resource:' });

  it('locks the CSP to the per-load nonce', () => {
    expect(html).toContain("script-src 'nonce-NONCE123'");
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('<script nonce="NONCE123">');
  });

  it('asks the host for the first render and swaps the graph on update', () => {
    expect(html).toContain("vscode.postMessage({ type: 'ready' })");
    expect(html).toContain("msg.type !== 'render'");
    expect(html).toContain('graphEl.innerHTML = msg.svg');
  });

  it('includes a health legend and an aria-live summary region', () => {
    expect(html).toContain('gc-legend');
    expect(html).toContain('health-error');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="gc-topology"');
  });
});
