import { describe, expect, it } from 'vitest';
import { createCockpitClient } from '../api/client';
import { jsonResponse, mockFetch, problemResponse } from '../test/helpers';
import { PENDING_KIND_PROMPT_FOR_INPUT, PENDING_KIND_TOOL_APPROVAL } from '../api/index';
import { approvalKey, fetchPendingApprovals } from './pending';

/** A client whose responses are routed by request path. */
function clientFor(routes: Record<string, () => Response>) {
  const { fetch, calls } = mockFetch((req) => {
    const path = new URL(req.url).pathname;
    const route = routes[path];
    return route ? route() : jsonResponse({ items: [], partial: false, partial_errors: [], total: 0 });
  });
  const client = createCockpitClient({ baseUrl: 'http://api.test', fetch });
  return { client, calls };
}

const cities = (items: Array<{ name: string; running: boolean }>) =>
  jsonResponse({ items, total: items.length });

const pending = (items: Array<{ kind: string; request_id: string; session_id: string }>) =>
  jsonResponse({ items, partial: false, partial_errors: [], total: items.length });

describe('fetchPendingApprovals', () => {
  it('unions pending interactions across running cities, tagged by city', async () => {
    const { client, calls } = clientFor({
      '/v0/cities': () =>
        cities([
          { name: 'hq', running: true },
          { name: 'stopped', running: false },
          { name: 'beta', running: true },
        ]),
      '/v0/city/hq/pending': () =>
        pending([{ kind: PENDING_KIND_TOOL_APPROVAL, request_id: 'r1', session_id: 's1' }]),
      '/v0/city/beta/pending': () =>
        pending([{ kind: PENDING_KIND_PROMPT_FOR_INPUT, request_id: 'r2', session_id: 's2' }]),
    });

    const result = await fetchPendingApprovals(client);

    expect(result).toEqual([
      { city: 'hq', sessionId: 's1', requestId: 'r1', kind: PENDING_KIND_TOOL_APPROVAL },
      { city: 'beta', sessionId: 's2', requestId: 'r2', kind: PENDING_KIND_PROMPT_FOR_INPUT },
    ]);
    // The stopped city is never queried — it cannot answer.
    expect(calls.some((c) => new URL(c.url).pathname === '/v0/city/stopped/pending')).toBe(false);
  });

  it('skips a city whose pending query fails, keeping the rest', async () => {
    const { client } = clientFor({
      '/v0/cities': () => cities([{ name: 'hq', running: true }, { name: 'beta', running: true }]),
      '/v0/city/hq/pending': () =>
        pending([{ kind: PENDING_KIND_TOOL_APPROVAL, request_id: 'r1', session_id: 's1' }]),
      '/v0/city/beta/pending': () => problemResponse({ title: 'rig beta unreachable' }, { status: 503 }),
    });

    const result = await fetchPendingApprovals(client);

    expect(result).toEqual([
      { city: 'hq', sessionId: 's1', requestId: 'r1', kind: PENDING_KIND_TOOL_APPROVAL },
    ]);
  });

  it('returns [] when the city listing itself fails', async () => {
    const { client } = clientFor({
      '/v0/cities': () => problemResponse({ title: 'supervisor down' }, { status: 500 }),
    });
    expect(await fetchPendingApprovals(client)).toEqual([]);
  });

  it('returns [] when no city has pending interactions', async () => {
    const { client } = clientFor({
      '/v0/cities': () => cities([{ name: 'hq', running: true }]),
    });
    expect(await fetchPendingApprovals(client)).toEqual([]);
  });
});

describe('approvalKey', () => {
  it('is stable and unique per city/session/request', () => {
    expect(approvalKey({ city: 'hq', sessionId: 's1', requestId: 'r1', kind: 'tool-approval' })).toBe(
      'appr:hq/s1/r1',
    );
  });
});
