import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  CliTransport,
  cliArgsFor,
  GxClient,
  GxClientError,
  RpcTransport,
  type ExecFileLike,
  type FetchLike,
  type GxEndpoint,
  type GxParams,
  type GxTransport,
} from './gxClient.ts';

const sessionJson = {
  sessionId: 'G0abc',
  projectId: 'P0xyz',
  globalRef: 'S0a:P0xyz:G0abc',
  kind: 'agent',
  title: 'claude',
  lifecycleState: 'running',
  surface: 'workspace',
  isFavorite: false,
  isPinned: false,
  createdAt: '2026-06-12T00:00:00Z',
  updatedAt: '2026-06-12T00:00:00Z',
};

/** A scripted transport: returns canned payloads and records calls. */
class FakeTransport implements GxTransport {
  readonly kind = 'rpc' as const;
  calls: { endpoint: GxEndpoint; params: GxParams }[] = [];
  constructor(private readonly responder: (endpoint: GxEndpoint, params: GxParams) => unknown) {}
  call(endpoint: GxEndpoint, params: GxParams): Promise<unknown> {
    this.calls.push({ endpoint, params });
    return Promise.resolve(this.responder(endpoint, params));
  }
}

// ---- cliArgsFor ------------------------------------------------------------

test('cliArgsFor maps endpoints to gx argv with kebab-cased flags', () => {
  assert.deepEqual(cliArgsFor('listSessions', {}), ['sessions']);
  assert.deepEqual(cliArgsFor('listProjects', {}), ['projects']);
  assert.deepEqual(cliArgsFor('readPresentationSnapshot', {}), ['snapshot']);
  assert.deepEqual(cliArgsFor('createAgentSession', { projectId: 'P0xyz', agentId: 'claude' }), [
    'create-agent',
    '--project-id',
    'P0xyz',
    '--agent-id',
    'claude',
  ]);
  assert.deepEqual(cliArgsFor('sendSessionText', { sessionId: 'G0abc', text: 'hi' }), [
    'send-text',
    '--session-id',
    'G0abc',
    '--text',
    'hi',
  ]);
  assert.deepEqual(cliArgsFor('runBeadsAction', { action: 'board', projectId: 'P0xyz' }), [
    'beads',
    '--action',
    'board',
    '--project-id',
    'P0xyz',
  ]);
});

test('cliArgsFor threads the agents-bridge cwd onto create-agent', () => {
  assert.deepEqual(
    cliArgsFor('createAgentSession', { projectId: 'P0xyz', agentId: 'claude', cwd: '/wt/furiosa' }),
    ['create-agent', '--project-id', 'P0xyz', '--agent-id', 'claude', '--cwd', '/wt/furiosa'],
  );
});

test('cliArgsFor omits absent flags and falls back to the bare endpoint', () => {
  assert.deepEqual(cliArgsFor('readSessionText', {}), ['read-text']);
  assert.deepEqual(cliArgsFor('focusSession', { sessionId: 'G0abc' }), ['focus', '--session-id', 'G0abc']);
  assert.deepEqual(cliArgsFor('listSessions' as GxEndpoint, {}), ['sessions']);
});

test('cliArgsFor maps every endpoint to a base verb', () => {
  const cases: Record<GxEndpoint, string> = {
    listSessions: 'sessions',
    listProjects: 'projects',
    createSession: 'create-session',
    createAgentSession: 'create-agent',
    readSessionText: 'read-text',
    sendSessionText: 'send-text',
    sendSessionMessage: 'send-message',
    sleepSession: 'sleep',
    wakeSession: 'wake',
    killSession: 'kill',
    focusSession: 'focus',
    readPresentationSnapshot: 'snapshot',
    runBeadsAction: 'beads',
    runGitAction: 'git',
    runWorktreeAction: 'worktree',
  };
  for (const [endpoint, verb] of Object.entries(cases) as [GxEndpoint, string][]) {
    assert.equal(cliArgsFor(endpoint, { sessionId: 'G1', projectId: 'P1', text: 't', action: 'a', title: 'x' })[0], verb);
  }
  // an unmapped verb falls back to itself
  assert.deepEqual(cliArgsFor('totallyUnknown' as GxEndpoint, {}), ['totallyUnknown']);
});

// ---- CliTransport ----------------------------------------------------------

function fakeExec(
  impl: (
    file: string,
    args: readonly string[],
  ) => { error?: Error & { code?: string | number; killed?: boolean }; stdout?: string; stderr?: string },
): ExecFileLike {
  return (file, args, _options, callback) => {
    const { error, stdout = '', stderr = '' } = impl(file, args);
    callback(error ?? null, stdout, stderr);
  };
}

test('CliTransport appends --json and parses stdout', async () => {
  let seenFile = '';
  let seenArgs: readonly string[] = [];
  const transport = new CliTransport({
    gxPath: '/usr/local/bin/gx',
    execFileImpl: fakeExec((file, args) => {
      seenFile = file;
      seenArgs = args;
      return { stdout: JSON.stringify([sessionJson]) };
    }),
  });
  const result = await transport.call('listSessions', {});
  assert.equal(seenFile, '/usr/local/bin/gx');
  assert.deepEqual(seenArgs, ['sessions', '--json']);
  assert.deepEqual(result, [sessionJson]);
});

test('CliTransport maps ENOENT to binaryMissing', async () => {
  const transport = new CliTransport({
    execFileImpl: fakeExec(() => ({ error: Object.assign(new Error('spawn gx ENOENT'), { code: 'ENOENT' }) })),
  });
  await assert.rejects(transport.call('listSessions', {}), (err: unknown) => {
    assert.ok(err instanceof GxClientError);
    assert.equal(err.code, 'binaryMissing');
    assert.equal(err.transport, 'cli');
    return true;
  });
});

test('CliTransport maps a killed/ETIMEDOUT process to timeout', async () => {
  const transport = new CliTransport({
    timeoutMs: 50,
    execFileImpl: fakeExec(() => ({ error: Object.assign(new Error('killed'), { killed: true }) })),
  });
  await assert.rejects(transport.call('listSessions', {}), (err: unknown) => {
    assert.ok(err instanceof GxClientError);
    assert.equal(err.code, 'timeout');
    return true;
  });
});

test('CliTransport maps a non-zero exit to nonZeroExit with stderr detail', async () => {
  const transport = new CliTransport({
    execFileImpl: fakeExec(() => ({
      error: Object.assign(new Error('Command failed'), { code: 1 }),
      stderr: 'no such session',
    })),
  });
  await assert.rejects(transport.call('readSessionText', { sessionId: 'G0abc' }), (err: unknown) => {
    assert.ok(err instanceof GxClientError);
    assert.equal(err.code, 'nonZeroExit');
    assert.match(err.message, /no such session/);
    return true;
  });
});

test('CliTransport maps unparseable stdout to malformedResponse', async () => {
  const transport = new CliTransport({
    execFileImpl: fakeExec(() => ({ stdout: 'not json at all' })),
  });
  await assert.rejects(transport.call('listSessions', {}), (err: unknown) => {
    assert.ok(err instanceof GxClientError);
    assert.equal(err.code, 'malformedResponse');
    return true;
  });
});

// ---- RpcTransport ----------------------------------------------------------

function okEnvelope(result: unknown): Response {
  return new Response(
    JSON.stringify({ ok: true, product: 'gxserver', protocolVersion: 1, requestId: 'r1', result }),
    { status: 200 },
  );
}

test('RpcTransport posts the envelope with auth + protocol headers and unwraps result', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const fetchImpl: FetchLike = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return okEnvelope({ sessions: [sessionJson] });
  };
  const transport = new RpcTransport({ baseUrl: 'http://127.0.0.1:58744/', token: 's3kr3t', fetchImpl });
  const result = await transport.call('listSessions', { foo: 'bar' });

  assert.equal(seenUrl, 'http://127.0.0.1:58744/api/listSessions');
  const headers = new Headers(seenInit?.headers);
  assert.equal(headers.get('authorization'), 'Bearer s3kr3t');
  assert.equal(headers.get('x-gxserver-protocol-version'), '1');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(seenInit?.body)), { params: { foo: 'bar' }, protocolVersion: 1 });
  assert.deepEqual(result, { sessions: [sessionJson] });
});

test('RpcTransport omits the auth header when no token is set', async () => {
  let auth: string | null = 'unset';
  const fetchImpl: FetchLike = async (_url, init) => {
    auth = new Headers(init?.headers).get('authorization');
    return okEnvelope({});
  };
  await new RpcTransport({ fetchImpl }).call('listProjects', {});
  assert.equal(auth, null);
});

test('RpcTransport surfaces an error envelope as rpcError', async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ ok: false, product: 'gxserver', error: 'notFound', message: 'gone' }), {
      status: 200,
    });
  await assert.rejects(new RpcTransport({ fetchImpl }).call('killSession', { sessionId: 'G9' }), (err: unknown) => {
    assert.ok(err instanceof GxClientError);
    assert.equal(err.code, 'rpcError');
    assert.match(err.message, /notFound/);
    return true;
  });
});

test('RpcTransport surfaces a protocolMismatch error envelope distinctly', async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(
      JSON.stringify({ ok: false, product: 'gxserver', error: 'protocolMismatch', message: 'update' }),
      { status: 400 },
    );
  await assert.rejects(new RpcTransport({ fetchImpl }).call('listSessions', {}), (err: unknown) => {
    assert.ok(err instanceof GxClientError);
    assert.equal(err.code, 'protocolMismatch');
    return true;
  });
});

test('RpcTransport maps a bare non-2xx (no envelope) to http', async () => {
  const fetchImpl: FetchLike = async () => new Response('Internal Error', { status: 500 });
  await assert.rejects(new RpcTransport({ fetchImpl }).call('listSessions', {}), (err: unknown) => {
    assert.ok(err instanceof GxClientError);
    assert.equal(err.code, 'http');
    assert.match(err.message, /HTTP 500/);
    return true;
  });
});

test('RpcTransport maps a network failure to unreachable', async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(new RpcTransport({ fetchImpl }).call('listSessions', {}), (err: unknown) => {
    assert.ok(err instanceof GxClientError);
    assert.equal(err.code, 'unreachable');
    return true;
  });
});

test('RpcTransport aborts and reports timeout', async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  await assert.rejects(
    new RpcTransport({ fetchImpl, timeoutMs: 10 }).call('listSessions', {}),
    (err: unknown) => {
      assert.ok(err instanceof GxClientError);
      assert.equal(err.code, 'timeout');
      return true;
    },
  );
});

test('RpcTransport rejects a 200 that is missing the ok/result envelope', async () => {
  const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ surprise: true }), { status: 200 });
  await assert.rejects(new RpcTransport({ fetchImpl }).call('listSessions', {}), (err: unknown) => {
    assert.ok(err instanceof GxClientError);
    assert.equal(err.code, 'malformedResponse');
    return true;
  });
});

test('RpcTransport rejects non-JSON bodies as malformedResponse', async () => {
  const fetchImpl: FetchLike = async () => new Response('<html>', { status: 200 });
  await assert.rejects(new RpcTransport({ fetchImpl }).call('listSessions', {}), (err: unknown) => {
    assert.ok(err instanceof GxClientError);
    assert.equal(err.code, 'malformedResponse');
    return true;
  });
});

test('RpcTransport throws when no fetch implementation is available', () => {
  // Neither an injected impl nor a global `fetch`: the transport cannot run.
  const savedFetch = globalThis.fetch;
  try {
    (globalThis as { fetch?: unknown }).fetch = undefined;
    assert.throws(
      () => new RpcTransport(),
      (err: unknown) => {
        assert.ok(err instanceof GxClientError);
        assert.equal(err.code, 'unreachable');
        return true;
      },
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// ---- GxClient (over a fake transport) --------------------------------------

test('GxClient.listSessions projects to domain sessions', async () => {
  const client = new GxClient(new FakeTransport(() => ({ sessions: [sessionJson] })));
  assert.equal(client.transportKind, 'rpc');
  const sessions = await client.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'G0abc');
});

test('GxClient.createAgentSession unwraps { session } and a bare session', async () => {
  const wrapped = new GxClient(new FakeTransport(() => ({ session: sessionJson })));
  assert.equal((await wrapped.createAgentSession({ projectId: 'P0xyz', agentId: 'claude' })).sessionId, 'G0abc');
  const bare = new GxClient(new FakeTransport(() => sessionJson));
  assert.equal((await bare.createSession({ projectId: 'P0xyz' })).sessionId, 'G0abc');
});

test('GxClient.createAgentSession forwards the optional cwd to the transport', async () => {
  const fake = new FakeTransport(() => ({ session: sessionJson }));
  await new GxClient(fake).createAgentSession({ projectId: 'P0xyz', agentId: 'claude', cwd: '/wt/furiosa' });
  assert.deepEqual(fake.calls[0].params, { projectId: 'P0xyz', agentId: 'claude', cwd: '/wt/furiosa' });
});

test('GxClient.readSessionText returns the text payload', async () => {
  const client = new GxClient(new FakeTransport(() => ({ text: 'hello from the agent' })));
  assert.equal(await client.readSessionText({ sessionId: 'G0abc' }), 'hello from the agent');
});

test('GxClient lifecycle methods forward params and project { session }', async () => {
  const fake = new FakeTransport(() => ({ session: sessionJson }));
  const client = new GxClient(fake);
  await client.sleepSession({ sessionId: 'G0abc', projectId: 'P0xyz' });
  await client.wakeSession({ sessionId: 'G0abc', projectId: 'P0xyz' });
  await client.killSession({ sessionId: 'G0abc' });
  const focus = await client.focusSession({ sessionId: 'G0abc' });
  assert.equal(focus.session.sessionId, 'G0abc');
  assert.deepEqual(
    fake.calls.map((c) => c.endpoint),
    ['sleepSession', 'wakeSession', 'killSession', 'focusSession'],
  );
  assert.deepEqual(fake.calls[0].params, { sessionId: 'G0abc', projectId: 'P0xyz' });
});

test('GxClient send* methods resolve void and forward params', async () => {
  const fake = new FakeTransport(() => ({}));
  const client = new GxClient(fake);
  await client.sendSessionText({ sessionId: 'G0abc', text: 'hi' });
  await client.sendSessionMessage({ sessionId: 'G0abc', text: 'yo' });
  assert.deepEqual(fake.calls[0].params, { sessionId: 'G0abc', text: 'hi' });
  assert.equal(fake.calls[1].endpoint, 'sendSessionMessage');
});

test('GxClient.runBeadsAction projects board items', async () => {
  const client = new GxClient(
    new FakeTransport(() => ({ issues: [{ id: 'bd-1', title: 'fix', status: 'open' }] })),
  );
  const items = await client.runBeadsAction({ action: 'board', projectId: 'P0xyz' });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'fix');
});

test('GxClient.runGitAction / runWorktreeAction project typed op results', async () => {
  const git = new GxClient(new FakeTransport(() => ({ action: 'status', exitCode: 0, stdout: 'clean', stderr: '' })));
  assert.equal((await git.runGitAction({ action: 'status' })).stdout, 'clean');
  const wt = new GxClient(
    new FakeTransport(() => ({
      action: 'list',
      exitCode: 0,
      stdout: '',
      stderr: '',
      worktrees: [{ path: '/wt', branch: 'main', bare: false, detached: false }],
    })),
  );
  assert.equal((await wt.runWorktreeAction({ action: 'list' })).worktrees?.[0].branch, 'main');
});

test('GxClient.listProjects and readPresentationSnapshot project correctly', async () => {
  const projects = new GxClient(new FakeTransport(() => ({ projects: [{ projectId: 'P0xyz', name: 'r' }] })));
  assert.equal((await projects.listProjects())[0].projectId, 'P0xyz');
  const snap = new GxClient(
    new FakeTransport(() => ({ revision: 3, generatedAt: 't', projects: [], groups: [], sessions: [] })),
  );
  assert.equal((await snap.readPresentationSnapshot()).revision, 3);
});

test('GxClient wraps a projection failure as malformedResponse', async () => {
  // transport succeeds, but the payload is the wrong shape for the projector.
  const client = new GxClient(new FakeTransport(() => ({ sessions: [{ noId: true }] })));
  await assert.rejects(client.listSessions(), (err: unknown) => {
    assert.ok(err instanceof GxClientError);
    assert.equal(err.code, 'malformedResponse');
    return true;
  });
});

test('GxClient.cli / GxClient.rpc construct over the expected transports', () => {
  assert.equal(GxClient.cli({ gxPath: 'gx' }).transportKind, 'cli');
  assert.equal(GxClient.rpc({ fetchImpl: (async () => new Response('{}')) as FetchLike }).transportKind, 'rpc');
});

test('GxClient over a CLI transport runs the gx binary and projects the result', async () => {
  let seenArgs: readonly string[] = [];
  const client = new GxClient(
    new CliTransport({
      gxPath: 'gx',
      execFileImpl: (_file, args, _options, cb) => {
        seenArgs = args;
        cb(null, JSON.stringify({ session: sessionJson }), '');
      },
    }),
  );
  const created = await client.createAgentSession({ projectId: 'P0xyz', agentId: 'claude' });
  assert.deepEqual(seenArgs, ['create-agent', '--project-id', 'P0xyz', '--agent-id', 'claude', '--json']);
  assert.equal(created.sessionId, 'G0abc');
});
