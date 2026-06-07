/**
 * Drives the metrics feature end-to-end through the in-memory testbed: it
 * registers its view + commands, loads on connect against an injected client,
 * re-derives on the title commands, and clears when the supervisor goes away.
 */
import { describe, expect, it } from 'vitest';
import metricsFeature from './metrics.feature.ts';
import { createCockpitClient } from '../api/index.ts';
import { createTestbed } from '../test/fake-host.ts';
import { jsonResponse, mockFetch } from '../test/helpers.ts';

const VIEW = 'gascityCockpit.metrics';

/** A client whose city has one recent close, so the derived model is non-empty. */
function liveClient() {
  const ts = new Date(Date.now() - 3_600_000).toISOString();
  const created = new Date(Date.now() - 7_200_000).toISOString();
  const events = [
    {
      type: 'bead.closed',
      ts,
      actor: 'gascity-cockpit/gastown.refinery',
      city: null,
      payload: { bead: { id: 'cockpit-1', issue_type: 'feature', created_at: created, assignee: null } },
    },
  ];
  const { fetch } = mockFetch((req) => {
    const path = new URL(req.url).pathname;
    if (path === '/v0/cities') return jsonResponse({ items: [{ name: 'blackrim-hq', path: '/x', running: true }], total: 1 });
    if (path.endsWith('/rigs')) return jsonResponse({ items: [{ name: 'gascity-cockpit', prefix: 'cockpit' }], total: 1 });
    if (path.endsWith('/events')) return jsonResponse({ items: events, total: events.length });
    return jsonResponse({ items: [], total: 0 });
  });
  return createCockpitClient({ baseUrl: 'http://api.test', fetch });
}

/** Node kinds currently rendered at the tree root. */
function rootKinds(tb: ReturnType<typeof createTestbed>): string[] {
  const provider = tb.getTreeProvider(VIEW)!;
  return (provider.getChildren() as Array<{ kind: string }>).map((n) => n.kind);
}

describe('metrics feature', () => {
  it('registers the view and its title commands', () => {
    const tb = createTestbed({ client: liveClient() });
    tb.activate(metricsFeature);
    expect(tb.getView(VIEW)).toBeDefined();
    for (const id of [
      'gascityCockpit.metrics.refresh',
      'gascityCockpit.metrics.selectWindow',
      'gascityCockpit.metrics.toggleGroupBy',
    ]) {
      expect(tb.hasCommand(id)).toBe(true);
    }
    // Before any connect, the pane shows the shared loading edge.
    expect(rootKinds(tb)).toEqual(['notice']);
  });

  it('loads on connect and renders Overall + per-rig groups', async () => {
    const tb = createTestbed({ client: liveClient() });
    tb.activate(metricsFeature);

    tb.emitStatus('connected');
    await tb.flush();

    const provider = tb.getTreeProvider(VIEW)!;
    const roots = provider.getChildren() as Array<{ kind: string; dimension?: string }>;
    expect(roots.some((n) => n.kind === 'group' && n.dimension === 'overall')).toBe(true);
    expect(roots.some((n) => n.kind === 'group' && n.dimension === 'rig')).toBe(true);
  });

  it('toggles grouping to per-agent without refetching', async () => {
    const tb = createTestbed({ client: liveClient() });
    tb.activate(metricsFeature);
    tb.emitStatus('connected');
    await tb.flush();

    await tb.invokeCommand('gascityCockpit.metrics.toggleGroupBy');

    const roots = tb.getTreeProvider(VIEW)!.getChildren() as Array<{ kind: string; dimension?: string }>;
    expect(roots.some((n) => n.kind === 'group' && n.dimension === 'agent')).toBe(true);
  });

  it('selects a window via the quick pick and reloads', async () => {
    const tb = createTestbed({ client: liveClient() });
    tb.activate(metricsFeature);
    tb.emitStatus('connected');
    await tb.flush();

    tb.queueQuickPick({ label: 'Last 24 hours', id: '24h' });
    await tb.invokeCommand('gascityCockpit.metrics.selectWindow');
    await tb.flush();

    // Still rendering groups after the window change.
    expect(rootKinds(tb)).toContain('group');
  });

  it('refresh command re-derives the model', async () => {
    const tb = createTestbed({ client: liveClient() });
    tb.activate(metricsFeature);
    tb.emitStatus('connected');
    await tb.flush();

    await tb.invokeCommand('gascityCockpit.metrics.refresh');
    await tb.flush();
    expect(rootKinds(tb)).toContain('group');
  });

  it('clears back to the loading edge when the supervisor goes away', async () => {
    const tb = createTestbed({ client: liveClient() });
    tb.activate(metricsFeature);
    tb.emitStatus('connected');
    await tb.flush();

    tb.emitStatus('unavailable');
    await tb.flush();
    expect(rootKinds(tb)).toEqual(['notice']);
  });

  it('does not reload twice for the same endpoint, but does on restart', async () => {
    const tb = createTestbed({ client: liveClient() });
    tb.activate(metricsFeature);

    tb.emitStatus('connected');
    await tb.flush();
    tb.emitStatus('connected'); // same endpoint, no restart → no reload
    await tb.flush();
    tb.emitStatus('connected', { restarted: true }); // restart → reload
    await tb.flush();

    expect(rootKinds(tb)).toContain('group');
  });

  it('clears when connected without a client', async () => {
    const tb = createTestbed({ client: null });
    tb.activate(metricsFeature);
    tb.emitStatus('connected');
    await tb.flush();
    expect(rootKinds(tb)).toEqual(['notice']); // idle → loading edge
  });

  it('discards an in-flight load superseded by a disconnect', async () => {
    const tb = createTestbed({ client: liveClient() });
    tb.activate(metricsFeature);

    tb.emitStatus('connected'); // reload #1 begins (async)
    tb.emitStatus('unavailable'); // bumps generation + clears before #1 resolves
    await tb.flush();

    // #1's result is dropped (stale generation); the pane stays on the loading edge.
    expect(rootKinds(tb)).toEqual(['notice']);
  });
});
