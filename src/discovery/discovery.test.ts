import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveEndpoint, type DiscoveryInputs } from './discovery.ts';
import { buildDescriptor, serializeDescriptor } from './descriptor.ts';
import type { HealthResponse } from './types.ts';

const HEALTH: HealthResponse = {
  status: 'ok',
  version: 'dev',
  build_id: 'B1',
  uptime_sec: 1,
  cities_total: 1,
  cities_running: 1,
  startup: { ready: true, phase: 'running', phases_completed: [] },
};

/** A probe that succeeds only for URLs in `reachable`. */
function probeFor(reachable: Set<string>) {
  const calls: string[] = [];
  const probe = async (baseUrl: string) => {
    calls.push(baseUrl);
    if (reachable.has(baseUrl)) return HEALTH;
    throw new Error('connection refused');
  };
  return { probe, calls };
}

/** A fs reader backed by an in-memory map; rejects for unknown paths. */
function fsFor(files: Record<string, string>) {
  return async (path: string) => {
    if (path in files) return files[path]!;
    throw new Error('ENOENT');
  };
}

function inputs(over: Partial<DiscoveryInputs>): DiscoveryInputs {
  return {
    settingsUrl: null,
    settingsToken: null,
    descriptorPaths: [],
    defaultBaseUrl: 'http://127.0.0.1:8372',
    readFile: fsFor({}),
    probe: async () => HEALTH,
    ...over,
  };
}

test('settings override wins when reachable', async () => {
  const { probe, calls } = probeFor(new Set(['http://127.0.0.1:9000']));
  const r = await resolveEndpoint(inputs({ settingsUrl: 'http://127.0.0.1:9000/', settingsToken: 'tok', probe }));
  assert.equal(r.ok, true);
  assert.equal(r.endpoint?.baseUrl, 'http://127.0.0.1:9000');
  assert.equal(r.endpoint?.source, 'settings');
  assert.equal(r.endpoint?.token, 'tok');
  assert.deepEqual(calls, ['http://127.0.0.1:9000']); // stopped at the first rung
});

test('unreachable settings override falls through to default', async () => {
  const { probe } = probeFor(new Set(['http://127.0.0.1:8372']));
  const r = await resolveEndpoint(inputs({ settingsUrl: 'http://127.0.0.1:9999', probe }));
  assert.equal(r.ok, true);
  assert.equal(r.endpoint?.source, 'default');
  assert.equal(r.attempts[0]?.source, 'settings');
  assert.equal(r.attempts[0]?.ok, false);
});

test('descriptor is used when present and reachable', async () => {
  const descriptor = serializeDescriptor(
    buildDescriptor({ host: '127.0.0.1', port: 8372, mode: 'supervisor', api_version: '0.1.0', token: 'dtok' }),
  );
  const { probe } = probeFor(new Set(['http://127.0.0.1:8372']));
  const r = await resolveEndpoint(
    inputs({ descriptorPaths: ['/home/.gc/api.json'], readFile: fsFor({ '/home/.gc/api.json': descriptor }), probe }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.endpoint?.source, 'descriptor');
  assert.equal(r.endpoint?.token, 'dtok');
});

test('a stale descriptor (dead port) is skipped, default used', async () => {
  const descriptor = serializeDescriptor(
    buildDescriptor({ host: '127.0.0.1', port: 5555, mode: 'supervisor', api_version: '0.1.0' }),
  );
  const { probe, calls } = probeFor(new Set(['http://127.0.0.1:8372'])); // 5555 is dead
  const r = await resolveEndpoint(
    inputs({ descriptorPaths: ['/home/.gc/api.json'], readFile: fsFor({ '/home/.gc/api.json': descriptor }), probe }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.endpoint?.source, 'default');
  assert.ok(calls.includes('http://127.0.0.1:5555')); // tried the stale one
  assert.ok(calls.includes('http://127.0.0.1:8372')); // then the default
});

test('an invalid descriptor is skipped with a recorded reason', async () => {
  const { probe } = probeFor(new Set(['http://127.0.0.1:8372']));
  const r = await resolveEndpoint(
    inputs({ descriptorPaths: ['/home/.gc/api.json'], readFile: fsFor({ '/home/.gc/api.json': '{bad' }), probe }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.endpoint?.source, 'default');
  const bad = r.attempts.find((a) => a.source === 'descriptor');
  assert.match(bad?.reason ?? '', /invalid/);
});

test('descriptor precedence: machine path before city path', async () => {
  const machine = serializeDescriptor(
    buildDescriptor({ host: '127.0.0.1', port: 8372, mode: 'supervisor', api_version: '0.1.0' }),
  );
  const city = serializeDescriptor(
    buildDescriptor({ host: '127.0.0.1', port: 9443, mode: 'standalone', api_version: '0.1.0' }),
  );
  const { probe } = probeFor(new Set(['http://127.0.0.1:8372', 'http://127.0.0.1:9443']));
  const r = await resolveEndpoint(
    inputs({
      descriptorPaths: ['/home/.gc/api.json', '/city/.gc/runtime/api.json'],
      readFile: fsFor({ '/home/.gc/api.json': machine, '/city/.gc/runtime/api.json': city }),
      probe,
    }),
  );
  assert.equal(r.endpoint?.baseUrl, 'http://127.0.0.1:8372'); // machine wins
});

test('default fallback works with no descriptor (today\'s reality)', async () => {
  const { probe } = probeFor(new Set(['http://127.0.0.1:8372']));
  const r = await resolveEndpoint(inputs({ probe }));
  assert.equal(r.ok, true);
  assert.equal(r.endpoint?.source, 'default');
  assert.equal(r.endpoint?.mode, 'supervisor');
});

test('nothing reachable => ok:false with full attempt trail', async () => {
  const { probe } = probeFor(new Set()); // nothing reachable
  const r = await resolveEndpoint(
    inputs({
      settingsUrl: 'http://127.0.0.1:9999',
      descriptorPaths: ['/missing.json'],
      probe,
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.endpoint, null);
  assert.ok(r.attempts.some((a) => a.source === 'settings' && !a.ok));
  assert.ok(r.attempts.some((a) => a.source === 'descriptor' && !a.ok));
  assert.ok(r.attempts.some((a) => a.source === 'default' && !a.ok));
});
