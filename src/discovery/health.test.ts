import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHealthy, parseHealth, ProbeError, probeHealth, type FetchLike } from './health.ts';

const liveBody = JSON.stringify({
  status: 'ok',
  version: 'dev',
  build_id: 'efd98eb6-dirty',
  uptime_sec: 8593,
  cities_total: 1,
  cities_running: 1,
  startup: { ready: true, phase: 'running', phases_completed: ['loading_config', 'starting_agents'] },
});

test('parseHealth reads the live /health shape', () => {
  const h = parseHealth(liveBody);
  assert.equal(h.status, 'ok');
  assert.equal(h.version, 'dev');
  assert.equal(h.build_id, 'efd98eb6-dirty');
  assert.equal(h.startup.ready, true);
  assert.equal(h.startup.phase, 'running');
  assert.deepEqual(h.startup.phases_completed, ['loading_config', 'starting_agents']);
});

test('parseHealth tolerates a missing startup block (assumes ready)', () => {
  const h = parseHealth(JSON.stringify({ status: 'ok' }));
  assert.equal(h.startup.ready, true);
  assert.equal(h.version, 'unknown');
});

test('parseHealth honors startup.ready=false', () => {
  const h = parseHealth(JSON.stringify({ status: 'ok', startup: { ready: false, phase: 'starting_agents' } }));
  assert.equal(h.startup.ready, false);
});

test('parseHealth rejects non-object / missing status', () => {
  assert.throws(() => parseHealth('[]'), /object/);
  assert.throws(() => parseHealth('{}'), /status/);
});

test('isHealthy requires ok + ready', () => {
  assert.equal(isHealthy(parseHealth(liveBody)), true);
  assert.equal(isHealthy(parseHealth(JSON.stringify({ status: 'ok', startup: { ready: false } }))), false);
  assert.equal(isHealthy(parseHealth(JSON.stringify({ status: 'degraded' }))), false);
});

test('probeHealth returns parsed health on 200', async () => {
  const fetchImpl: FetchLike = async () => new Response(liveBody, { status: 200 });
  const h = await probeHealth('http://127.0.0.1:8372/', { fetchImpl });
  assert.equal(h.status, 'ok');
});

test('probeHealth sends a bearer token when provided', async () => {
  let seenAuth: string | null = null;
  const fetchImpl: FetchLike = async (_url, init) => {
    seenAuth = new Headers(init?.headers).get('authorization');
    return new Response(liveBody, { status: 200 });
  };
  await probeHealth('http://127.0.0.1:8372', { token: 's3kr3t', fetchImpl });
  assert.equal(seenAuth, 'Bearer s3kr3t');
});

test('probeHealth requests the /health path', async () => {
  let seenUrl = '';
  const fetchImpl: FetchLike = async (url) => {
    seenUrl = url;
    return new Response(liveBody, { status: 200 });
  };
  await probeHealth('http://127.0.0.1:8372', { fetchImpl });
  assert.equal(seenUrl, 'http://127.0.0.1:8372/health');
});

test('probeHealth throws ProbeError on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => new Response('', { status: 503 });
  await assert.rejects(probeHealth('http://x:1', { fetchImpl }), /HTTP 503/);
});

test('probeHealth throws ProbeError on a network error', async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(probeHealth('http://x:1', { fetchImpl }), ProbeError);
});

test('probeHealth wraps an unparseable body as ProbeError', async () => {
  const fetchImpl: FetchLike = async () => new Response('<html>nope', { status: 200 });
  await assert.rejects(probeHealth('http://x:1', { fetchImpl }), ProbeError);
});

test('probeHealth aborts on timeout', async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
    });
  await assert.rejects(probeHealth('http://x:1', { fetchImpl, timeoutMs: 10 }), /timed out/);
});
