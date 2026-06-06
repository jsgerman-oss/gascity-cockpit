import { test } from 'vitest';
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

test('probeHealth throws when no fetch implementation is available', async () => {
  // A non-undefined, non-function value skips the destructuring default and hits
  // the `typeof fetchImpl !== "function"` guard.
  await assert.rejects(
    probeHealth('http://x:1', { fetchImpl: null as unknown as FetchLike }),
    /no fetch implementation/,
  );
});

test('probeHealth registers and cleans up a caller abort listener', async () => {
  const fetchImpl: FetchLike = async () => new Response(liveBody, { status: 200 });
  const controller = new AbortController();
  const h = await probeHealth('http://x:1', { fetchImpl, signal: controller.signal });
  assert.equal(h.status, 'ok');
  // The finally block removed the listener; aborting now must not throw.
  controller.abort();
});

test('probeHealth honors a caller signal already aborted before the probe', async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    init?.signal?.aborted
      ? Promise.reject(init.signal.reason ?? new Error('aborted'))
      : Promise.resolve(new Response(liveBody, { status: 200 }));
  const signal = AbortSignal.abort(new ProbeError('cancelled by caller'));
  await assert.rejects(probeHealth('http://x:1', { fetchImpl, signal }), /cancelled by caller/);
});

test('probeHealth stringifies a thrown non-Error value', async () => {
  const fetchImpl: FetchLike = async () => {
    throw 'kaboom'; // a bare string has no `.message`, so the `?? String(err)` arm runs
  };
  await assert.rejects(probeHealth('http://x:1', { fetchImpl }), /health probe failed: kaboom/);
});
