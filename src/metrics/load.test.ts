import { describe, expect, it } from 'vitest';
import { createCockpitClient } from '../api/index.ts';
import { jsonResponse, mockFetch, problemResponse } from '../test/helpers.ts';
import { EVENT_CAP_HINT, loadMetrics } from './load.ts';

const NOW = Date.parse('2026-06-06T03:00:00Z');
const RIGS = [
  { name: 'gascity-cockpit', prefix: 'cockpit' },
  { name: 'whiskeyshop', prefix: null },
];

function client(handler: (req: Request) => Response | Promise<Response>) {
  const { fetch, calls } = mockFetch(handler);
  return { c: createCockpitClient({ baseUrl: 'http://api.test', fetch }), calls };
}

function closedEnv(beadId: string, over: Record<string, unknown> = {}, bead: Record<string, unknown> = {}) {
  return {
    type: 'bead.closed',
    ts: '2026-06-06T02:00:00Z',
    actor: 'gascity-cockpit/gastown.refinery',
    city: null,
    payload: { bead: { id: beadId, issue_type: 'feature', created_at: '2026-06-06T00:00:00Z', ...bead } },
    ...over,
  };
}

function rejectedEnv(beadId: string, reason: string) {
  return {
    type: 'bead.updated',
    ts: '2026-06-06T02:30:00Z',
    actor: 'gascity-cockpit/gastown.refinery',
    payload: { bead: { id: beadId, issue_type: 'feature', metadata: { rejection_reason: reason } } },
  };
}

/** Route a request by path to one of the three endpoints the loader hits. */
function router(parts: {
  cities: () => Response;
  rigs?: () => Response;
  events: () => Response;
}) {
  return (req: Request): Response => {
    const path = new URL(req.url).pathname;
    if (path === '/v0/cities') return parts.cities();
    if (path.endsWith('/rigs')) return (parts.rigs ?? (() => jsonResponse({ items: RIGS, total: 2 })))();
    if (path.endsWith('/events')) return parts.events();
    return jsonResponse({ items: [], total: 0 });
  };
}

const oneCity = () => jsonResponse({ items: [{ name: 'blackrim-hq', path: '/x', running: true }], total: 1 });

describe('loadMetrics', () => {
  it('derives a model from a city event snapshot', async () => {
    const { c } = client(
      router({
        cities: oneCity,
        events: () => jsonResponse({ items: [closedEnv('cockpit-1'), rejectedEnv('cockpit-2', 'conflict')], total: 2 }),
      }),
    );
    const res = await loadMetrics(c, { windowId: '7d', nowMs: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.partial).toBe(false);
    expect(res.fetchedAtMs).toBe(NOW);
    expect(res.model.overall.throughput.total).toBe(1);
    expect(res.model.overall.reject.rejects).toBe(1);
    expect(res.model.byRig.map((g) => g.id)).toContain('gascity-cockpit');
  });

  it('errors only when the supervisor city list is unreachable', async () => {
    const { c } = client(
      router({
        cities: () =>
          problemResponse({ type: 'urn:gc:unavailable', title: 'Unavailable', detail: 'no supervisor', status: 503 }, { status: 503 }),
        events: () => jsonResponse({ items: [], total: 0 }),
      }),
    );
    const res = await loadMetrics(c, { windowId: '24h', nowMs: NOW });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.detail).toBe('no supervisor');
  });

  it('flags partial when a city event page is capped', async () => {
    const { c } = client(
      router({
        cities: oneCity,
        events: () => jsonResponse({ items: Array.from({ length: EVENT_CAP_HINT }, () => ({ type: 'heartbeat' })), total: EVENT_CAP_HINT }),
      }),
    );
    const res = await loadMetrics(c, { windowId: '7d', nowMs: NOW });
    expect(res.ok && res.partial).toBe(true);
    if (res.ok) expect(res.model.overall.throughput.total).toBe(0);
  });

  it('flags partial when a city event fetch fails, without failing the load', async () => {
    const { c } = client(
      router({
        cities: oneCity,
        events: () => problemResponse({ title: 'boom', status: 500 }, { status: 500 }),
      }),
    );
    const res = await loadMetrics(c, { windowId: '7d', nowMs: NOW });
    expect(res.ok && res.partial).toBe(true);
    if (res.ok) expect(res.model.overall.throughput.total).toBe(0);
  });

  it('tolerates a failed rigs fetch, attributing rig from the actor scope', async () => {
    const { c } = client(
      router({
        cities: oneCity,
        rigs: () => problemResponse({ title: 'no rigs', status: 500 }, { status: 500 }),
        events: () =>
          jsonResponse({
            items: [closedEnv('mystery-1', { actor: 'whiskeyshop/gastown.witness' }, { assignee: null })],
            total: 1,
          }),
      }),
    );
    const res = await loadMetrics(c, { windowId: '7d', nowMs: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.byRig.map((g) => g.id)).toEqual(['whiskeyshop']);
  });

  it('uses the error title when the failure carries no detail', async () => {
    const { c } = client(
      router({
        cities: () => problemResponse({ type: 'urn:gc:down', title: 'Down' }, { status: 500 }),
        events: () => jsonResponse({ items: [], total: 0 }),
      }),
    );
    const res = await loadMetrics(c, { windowId: '7d', nowMs: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toBe('Down');
  });

  it('treats an item-less events body as empty', async () => {
    const { c } = client(router({ cities: oneCity, events: () => jsonResponse({ total: 0 }) }));
    const res = await loadMetrics(c, { windowId: '7d', nowMs: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.model.overall.throughput.total).toBe(0);
      expect(res.partial).toBe(false);
    }
  });

  it('requests the window as a Go-duration since and a bounded limit', async () => {
    const { c, calls } = client(
      router({ cities: oneCity, events: () => jsonResponse({ items: [], total: 0 }) }),
    );
    await loadMetrics(c, { windowId: '7d', nowMs: NOW });
    const eventsCall = calls.find((r) => new URL(r.url).pathname.endsWith('/events'));
    expect(eventsCall).toBeDefined();
    const url = new URL(eventsCall!.url);
    expect(url.searchParams.get('since')).toBe('168h');
    expect(url.searchParams.get('limit')).toBe('5000');
  });
});
