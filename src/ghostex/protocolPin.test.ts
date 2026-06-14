// Release pin: the published manifest must declare exactly the gxserver
// protocol version the client actually speaks.
//
// `GXSERVER_PROTOCOL_VERSION` (src/ghostex/types.ts) is the single runtime
// source of truth — it is sent on every RPC (`x-gxserver-protocol-version`
// header + `protocolVersion` body), carried on the events WebSocket handshake,
// and hard-asserted at discovery (`probeGhostexHealth` throws `protocolMismatch`
// when the daemon disagrees). For the released `.vsix`, package.json *also*
// declares the supported version under `gascityCockpit.ghostex` so anyone
// inspecting the artifact knows which gxserver protocol it requires.
//
// Bumping the protocol is a breaking change that must move both in lockstep.
// This test fails on drift, so the published manifest can never claim a
// protocol version the code does not speak. Runs under `npm run check`.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GXSERVER_PROTOCOL_VERSION } from './types.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  gascityCockpit?: { ghostex?: { gxserverProtocolVersion?: unknown } };
};

describe('gxserver protocol pin', () => {
  it('the published manifest declares the protocol version the client speaks', () => {
    expect(pkg.gascityCockpit?.ghostex?.gxserverProtocolVersion).toBe(GXSERVER_PROTOCOL_VERSION);
  });
});
