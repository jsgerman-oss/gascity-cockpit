import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  discoverGhostex,
  GhostexProbeError,
  probeGhostexHealth,
  probeGhostexServerHealth,
  readiness,
  type FetchLike,
} from './discovery.ts';

const healthBody = JSON.stringify({ ok: true, product: 'gxserver', protocolVersion: 1, version: '1.2.3' });

function fetchReturning(response: Response | (() => Response | Promise<Response>)): FetchLike {
  return async () => (typeof response === 'function' ? response() : response);
}

// ---- probeGhostexHealth ----------------------------------------------------

test('probeGhostexHealth returns parsed health and hits /api/health', async () => {
  let seenUrl = '';
  const fetchImpl: FetchLike = async (url) => {
    seenUrl = url;
    return new Response(healthBody, { status: 200 });
  };
  const h = await probeGhostexHealth('http://127.0.0.1:58744/', { fetchImpl });
  assert.equal(seenUrl, 'http://127.0.0.1:58744/api/health');
  assert.equal(h.product, 'gxserver');
  assert.equal(h.protocolVersion, 1);
});

test('probeGhostexHealth sends a bearer token when provided', async () => {
  let auth: string | null = null;
  const fetchImpl: FetchLike = async (_url, init) => {
    auth = new Headers(init?.headers).get('authorization');
    return new Response(healthBody, { status: 200 });
  };
  await probeGhostexHealth('http://127.0.0.1:58744', { token: 'tok', fetchImpl });
  assert.equal(auth, 'Bearer tok');
});

test('probeGhostexHealth rejects a protocol mismatch with an actionable message', async () => {
  const fetchImpl = fetchReturning(
    new Response(JSON.stringify({ ok: true, product: 'gxserver', protocolVersion: 2, version: 'x' }), {
      status: 200,
    }),
  );
  await assert.rejects(probeGhostexHealth('http://x', { fetchImpl }), (err: unknown) => {
    assert.ok(err instanceof GhostexProbeError);
    assert.equal(err.reason, 'protocolMismatch');
    assert.match(err.message, /Update Ghostex/);
    return true;
  });
});

test('probeGhostexHealth rejects a non-gxserver product', async () => {
  const fetchImpl = fetchReturning(
    new Response(JSON.stringify({ ok: true, product: 'something-else', protocolVersion: 1, version: 'x' }), {
      status: 200,
    }),
  );
  await assert.rejects(probeGhostexHealth('http://x', { fetchImpl }), (err: unknown) => {
    assert.ok(err instanceof GhostexProbeError);
    assert.equal(err.reason, 'notGxserver');
    return true;
  });
});

test('probeGhostexHealth maps a non-2xx to http', async () => {
  const fetchImpl = fetchReturning(new Response('', { status: 503 }));
  await assert.rejects(probeGhostexHealth('http://x', { fetchImpl }), (err: unknown) => {
    assert.ok(err instanceof GhostexProbeError);
    assert.equal(err.reason, 'http');
    return true;
  });
});

test('probeGhostexHealth maps an unparseable body to malformedHealth', async () => {
  const fetchImpl = fetchReturning(new Response('<html>', { status: 200 }));
  await assert.rejects(probeGhostexHealth('http://x', { fetchImpl }), (err: unknown) => {
    assert.ok(err instanceof GhostexProbeError);
    assert.equal(err.reason, 'malformedHealth');
    return true;
  });
});

test('probeGhostexHealth maps a network error to unreachable', async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(probeGhostexHealth('http://x', { fetchImpl }), (err: unknown) => {
    assert.ok(err instanceof GhostexProbeError);
    assert.equal(err.reason, 'unreachable');
    return true;
  });
});

test('probeGhostexHealth times out as unreachable', async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  await assert.rejects(probeGhostexHealth('http://x', { fetchImpl, timeoutMs: 10 }), (err: unknown) => {
    assert.ok(err instanceof GhostexProbeError);
    assert.equal(err.reason, 'unreachable');
    assert.match(err.message, /timed out/);
    return true;
  });
});

test('probeGhostexHealth tolerates a body without a product field', async () => {
  const fetchImpl = fetchReturning(new Response(JSON.stringify({ ok: true, protocolVersion: 1, version: 'x' }), { status: 200 }));
  const h = await probeGhostexHealth('http://x', { fetchImpl });
  assert.equal(h.protocolVersion, 1);
});

// ---- probeGhostexServerHealth ----------------------------------------------

test('probeGhostexServerHealth reads the detailed body with auth + protocol headers', async () => {
  let url = '';
  let headers: Headers | undefined;
  const fetchImpl: FetchLike = async (u, init) => {
    url = u;
    headers = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        ok: true,
        product: 'gxserver',
        protocolVersion: 1,
        version: '1.2.3',
        serverId: 'S0a',
        buildIdentity: 'b1',
        pid: 7,
        port: 58744,
        startedAt: 't',
        capabilities: ['sessions'],
      }),
      { status: 200 },
    );
  };
  const sh = await probeGhostexServerHealth('http://127.0.0.1:58744', { token: 'tok', fetchImpl });
  assert.equal(url, 'http://127.0.0.1:58744/api/health/server');
  assert.equal(headers?.get('authorization'), 'Bearer tok');
  assert.equal(headers?.get('x-gxserver-protocol-version'), '1');
  assert.equal(sh.serverId, 'S0a');
  assert.equal(sh.buildIdentity, 'b1');
});

test('probeGhostexServerHealth maps a non-2xx to http', async () => {
  const fetchImpl = fetchReturning(new Response('', { status: 401 }));
  await assert.rejects(probeGhostexServerHealth('http://x', { token: 't', fetchImpl }), (err: unknown) => {
    assert.ok(err instanceof GhostexProbeError);
    assert.equal(err.reason, 'http');
    return true;
  });
});

test('probeGhostexServerHealth maps a malformed body, network error, and timeout', async () => {
  await assert.rejects(
    probeGhostexServerHealth('http://x', { token: 't', fetchImpl: fetchReturning(new Response('<html>', { status: 200 })) }),
    (err: unknown) => {
      assert.ok(err instanceof GhostexProbeError);
      assert.equal(err.reason, 'malformedHealth');
      return true;
    },
  );
  await assert.rejects(
    probeGhostexServerHealth('http://x', {
      token: 't',
      fetchImpl: async () => {
        throw new Error('down');
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof GhostexProbeError);
      assert.equal(err.reason, 'unreachable');
      return true;
    },
  );
  await assert.rejects(
    probeGhostexServerHealth('http://x', {
      token: 't',
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    }),
    (err: unknown) => {
      assert.ok(err instanceof GhostexProbeError);
      assert.equal(err.reason, 'unreachable');
      assert.match(err.message, /timed out/);
      return true;
    },
  );
});

test('the probes guard against a missing fetch implementation', async () => {
  const savedFetch = globalThis.fetch;
  try {
    (globalThis as { fetch?: unknown }).fetch = undefined;
    await assert.rejects(probeGhostexHealth('http://x'), (err: unknown) => {
      assert.ok(err instanceof GhostexProbeError);
      assert.equal(err.reason, 'unreachable');
      return true;
    });
    await assert.rejects(probeGhostexServerHealth('http://x', { token: 't' }), (err: unknown) => {
      assert.ok(err instanceof GhostexProbeError);
      assert.equal(err.reason, 'unreachable');
      return true;
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('discoverGhostex produces actionable detail for http and notGxserver reasons', async () => {
  const httpResult = await discoverGhostex({ fetchImpl: fetchReturning(new Response('', { status: 503 })) });
  assert.equal(httpResult.state, 'unavailable');
  if (httpResult.state === 'unavailable') {
    assert.equal(httpResult.reason, 'http');
    assert.match(httpResult.detail, /rejected the health probe/);
  }

  const notGx = await discoverGhostex({
    fetchImpl: fetchReturning(
      new Response(JSON.stringify({ ok: true, product: 'other', protocolVersion: 1, version: 'x' }), { status: 200 }),
    ),
  });
  assert.equal(notGx.state, 'unavailable');
  if (notGx.state === 'unavailable') {
    assert.equal(notGx.reason, 'notGxserver');
    assert.match(notGx.detail, /gxserver/);
  }

  const malformed = await discoverGhostex({ fetchImpl: fetchReturning(new Response('<html>', { status: 200 })) });
  assert.equal(malformed.state, 'unavailable');
  if (malformed.state === 'unavailable') {
    assert.equal(malformed.reason, 'malformedHealth');
    assert.match(malformed.detail, /did not return a gxserver health body/);
  }
});

test('discoverGhostex treats an empty settings token as unset (falls back to file)', async () => {
  const result = await discoverGhostex({
    settingsToken: '   ',
    readTokenFile: async () => 'file-token',
    fetchImpl: fetchReturning(new Response(healthBody, { status: 200 })),
  });
  assert.equal(result.state, 'connected');
  if (result.state === 'connected') assert.equal(result.endpoint.tokenSource, 'file');
});

// ---- discoverGhostex -------------------------------------------------------

test('discoverGhostex connects via the default URL and reads the token file', async () => {
  let probedToken: string | null = null;
  const fetchImpl: FetchLike = async (_url, init) => {
    probedToken = new Headers(init?.headers).get('authorization');
    return new Response(healthBody, { status: 200 });
  };
  const result = await discoverGhostex({
    readTokenFile: async () => '  file-token\n',
    fetchImpl,
  });
  assert.equal(result.state, 'connected');
  if (result.state !== 'connected') return;
  assert.equal(result.endpoint.baseUrl, 'http://127.0.0.1:58744');
  assert.equal(result.endpoint.source, 'default');
  assert.equal(result.endpoint.tokenSource, 'file');
  assert.equal(result.endpoint.token, 'file-token');
  assert.equal(probedToken, 'Bearer file-token');
});

test('discoverGhostex prefers the settings URL and token over the file', async () => {
  const fetchImpl: FetchLike = async (url) => {
    assert.equal(url, 'http://10.0.0.5:9000/api/health');
    return new Response(healthBody, { status: 200 });
  };
  const result = await discoverGhostex({
    settingsUrl: 'http://10.0.0.5:9000/',
    settingsToken: 'settings-token',
    readTokenFile: async () => 'file-token',
    fetchImpl,
  });
  assert.equal(result.state, 'connected');
  if (result.state !== 'connected') return;
  assert.equal(result.endpoint.source, 'settings');
  assert.equal(result.endpoint.tokenSource, 'settings');
  assert.equal(result.endpoint.token, 'settings-token');
});

test('discoverGhostex tolerates a missing token file (tokenSource none)', async () => {
  const fetchImpl = fetchReturning(new Response(healthBody, { status: 200 }));
  const result = await discoverGhostex({
    readTokenFile: async () => {
      throw new Error('ENOENT');
    },
    fetchImpl,
  });
  assert.equal(result.state, 'connected');
  if (result.state !== 'connected') return;
  assert.equal(result.endpoint.tokenSource, 'none');
  assert.equal(result.endpoint.token, null);
});

test('discoverGhostex returns unavailable with an actionable detail when unreachable', async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error('ECONNREFUSED');
  };
  const result = await discoverGhostex({ fetchImpl });
  assert.equal(result.state, 'unavailable');
  if (result.state !== 'unavailable') return;
  assert.equal(result.reason, 'unreachable');
  assert.match(result.detail, /Is Ghostex running/);
  assert.match(result.detail, /gascityCockpit\.ghostex\.gxserverUrl/);
});

test('discoverGhostex surfaces a protocol mismatch as unavailable', async () => {
  const fetchImpl = fetchReturning(
    new Response(JSON.stringify({ ok: true, product: 'gxserver', protocolVersion: 99, version: 'x' }), {
      status: 200,
    }),
  );
  const result = await discoverGhostex({ fetchImpl });
  assert.equal(result.state, 'unavailable');
  if (result.state !== 'unavailable') return;
  assert.equal(result.reason, 'protocolMismatch');
  assert.match(result.detail, /Update Ghostex/);
});

test('discoverGhostex passes a custom timeout through to the probe', async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const result = await discoverGhostex({ fetchImpl, timeoutMs: 5 });
  assert.equal(result.state, 'unavailable');
  if (result.state !== 'unavailable') return;
  assert.equal(result.reason, 'unreachable');
});

// ---- readiness -------------------------------------------------------------

test('readiness reports ok with the endpoint when connected', async () => {
  const fetchImpl = fetchReturning(new Response(healthBody, { status: 200 }));
  const result = await discoverGhostex({ fetchImpl });
  const r = readiness(result);
  assert.equal(r.ok, true);
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.endpoint?.baseUrl, 'http://127.0.0.1:58744');
});

test('readiness reports not-ok with diagnostics when unavailable', async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error('down');
  };
  const r = readiness(await discoverGhostex({ fetchImpl }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.endpoint, undefined);
});

// ---- the optional logger + fetch defaults + defensive wrap -----------------
// These exercise the `inputs.log?.(...)` branches on each outcome path, the
// `fetchImpl`-absent default, and the defensive non-probe-error wrap.

test('discoverGhostex logs at info on a connected probe', async () => {
  const logs: Array<{ level: string; message: string }> = [];
  const result = await discoverGhostex({
    readTokenFile: async () => 'file-token',
    fetchImpl: fetchReturning(new Response(healthBody, { status: 200 })),
    log: (level, message) => logs.push({ level, message }),
  });
  assert.equal(result.state, 'connected');
  assert.ok(logs.some((l) => l.level === 'info' && /connected/.test(l.message)));
});

test('discoverGhostex logs at debug when the token file is absent', async () => {
  const logs: Array<{ level: string; message: string }> = [];
  const result = await discoverGhostex({
    readTokenFile: async () => {
      throw new Error('ENOENT');
    },
    fetchImpl: fetchReturning(new Response(healthBody, { status: 200 })),
    log: (level, message) => logs.push({ level, message }),
  });
  assert.equal(result.state, 'connected');
  if (result.state === 'connected') assert.equal(result.endpoint.tokenSource, 'none');
  assert.ok(logs.some((l) => l.level === 'debug' && /no token file/.test(l.message)));
});

test('discoverGhostex logs at warn when the probe is unavailable', async () => {
  const logs: Array<{ level: string; message: string }> = [];
  const result = await discoverGhostex({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    log: (level, message) => logs.push({ level, message }),
  });
  assert.equal(result.state, 'unavailable');
  assert.ok(logs.some((l) => l.level === 'warn' && /unavailable/.test(l.message)));
});

test('discoverGhostex wraps a non-probe error as unreachable instead of throwing', async () => {
  // A logger that throws *after* a healthy probe makes a plain Error (not a
  // GhostexProbeError) escape the try block, driving the defensive
  // `err instanceof GhostexProbeError ? … : new GhostexProbeError('unreachable')`
  // branch — discovery degrades to `unavailable` rather than crashing the caller.
  let warned = false;
  const result = await discoverGhostex({
    settingsToken: 'tok',
    fetchImpl: fetchReturning(new Response(healthBody, { status: 200 })),
    log: (level) => {
      if (level === 'info') throw new Error('logger boom');
      if (level === 'warn') warned = true;
    },
  });
  assert.equal(result.state, 'unavailable');
  if (result.state === 'unavailable') assert.equal(result.reason, 'unreachable');
  assert.equal(warned, true);
});

test('discoverGhostex falls back to the global fetch when none is injected', async () => {
  const savedFetch = globalThis.fetch;
  try {
    (globalThis as { fetch?: unknown }).fetch = async () => new Response(healthBody, { status: 200 });
    const result = await discoverGhostex({ settingsToken: 'tok' });
    assert.equal(result.state, 'connected');
    if (result.state === 'connected') assert.equal(result.endpoint.baseUrl, 'http://127.0.0.1:58744');
  } finally {
    globalThis.fetch = savedFetch;
  }
});
