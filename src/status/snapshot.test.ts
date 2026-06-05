import { describe, expect, it } from 'vitest';
import { createCockpitClient } from '../api/index';
import { jsonResponse, mockFetch, problemResponse } from '../test/helpers';
import { fetchFleetSnapshot } from './snapshot';

type Route = (req: Request) => Response;

/** A tiny path-keyed mock /v0 server. Unmatched routes 404. */
function server(routes: Record<string, Route>) {
  return mockFetch((req) => {
    const path = new URL(req.url).pathname;
    const route = routes[path];
    if (route) return route(req);
    return problemResponse({ title: 'not found', status: 404 }, { status: 404 });
  });
}

const healthBody = {
  status: 'ok',
  version: '0.1.0',
  uptime_sec: 10,
  cities_total: 2,
  cities_running: 1,
  startup: { ready: true },
};

describe('fetchFleetSnapshot', () => {
  it('fetches health, cities, and per-running-city agents and sessions', async () => {
    const mock = server({
      '/health': () => jsonResponse(healthBody),
      '/v0/cities': () =>
        jsonResponse({
          total: 2,
          items: [
            { name: 'alpha', path: '/a', running: true },
            { name: 'beta', path: '/b', running: false },
          ],
        }),
      '/v0/city/alpha/agents': () =>
        jsonResponse({ total: 1, items: [{ name: 'a1', running: true, suspended: false, state: 'working', available: true }] }),
      '/v0/city/alpha/sessions': () =>
        jsonResponse({
          total: 1,
          items: [
            {
              id: 's1',
              template: 'polecat',
              state: 'running',
              title: 'work',
              provider: 'anthropic',
              session_name: 'a1',
              created_at: 't',
              attached: false,
              running: true,
            },
          ],
        }),
    });
    const client = createCockpitClient({ baseUrl: 'http://api.test', fetch: mock.fetch });

    const snap = await fetchFleetSnapshot(client);

    expect(snap.health?.version).toBe('0.1.0');
    expect(snap.cities.map((c) => c.name)).toEqual(['alpha', 'beta']);
    expect(snap.agentsByCity.alpha).toHaveLength(1);
    expect(snap.sessionsByCity.alpha).toHaveLength(1);
    // The stopped city is never queried.
    expect(snap.agentsByCity.beta).toBeUndefined();
    expect(mock.calls.some((c) => new URL(c.url).pathname === '/v0/city/beta/agents')).toBe(false);
    expect(snap.partialErrors).toEqual([]);
  });

  it('records a partial error when a city enumeration fails, without aborting the snapshot', async () => {
    const mock = server({
      '/health': () => jsonResponse(healthBody),
      '/v0/cities': () => jsonResponse({ total: 1, items: [{ name: 'alpha', path: '/a', running: true }] }),
      '/v0/city/alpha/agents': () => problemResponse({ title: 'boom', status: 500 }, { status: 500 }),
      '/v0/city/alpha/sessions': () => jsonResponse({ total: 0, items: [] }),
    });
    const client = createCockpitClient({ baseUrl: 'http://api.test', fetch: mock.fetch });

    const snap = await fetchFleetSnapshot(client);

    expect(snap.agentsByCity.alpha).toEqual([]);
    expect(snap.sessionsByCity.alpha).toEqual([]);
    expect(snap.partialErrors.some((e) => e.startsWith('agents[alpha]'))).toBe(true);
  });

  it('survives a health failure, returning null health and a partial error', async () => {
    const mock = server({
      '/health': () => problemResponse({ title: 'down', status: 503 }, { status: 503 }),
      '/v0/cities': () => jsonResponse({ total: 0, items: [] }),
    });
    const client = createCockpitClient({ baseUrl: 'http://api.test', fetch: mock.fetch });

    const snap = await fetchFleetSnapshot(client);

    expect(snap.health).toBeNull();
    expect(snap.cities).toEqual([]);
    expect(snap.partialErrors.some((e) => e.startsWith('health'))).toBe(true);
  });

  it('treats a null items array as empty', async () => {
    const mock = server({
      '/health': () => jsonResponse(healthBody),
      '/v0/cities': () => jsonResponse({ total: 0, items: null }),
    });
    const client = createCockpitClient({ baseUrl: 'http://api.test', fetch: mock.fetch });

    const snap = await fetchFleetSnapshot(client);
    expect(snap.cities).toEqual([]);
  });
});
