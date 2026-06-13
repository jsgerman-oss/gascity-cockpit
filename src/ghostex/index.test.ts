import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as ghostex from './index.ts';

test('the ghostex barrel re-exports the public foundation surface', () => {
  // Constants
  assert.equal(ghostex.GXSERVER_PROTOCOL_VERSION, 1);
  assert.equal(ghostex.GXSERVER_PRODUCT, 'gxserver');
  assert.equal(ghostex.DEFAULT_GXSERVER_BASE_URL, 'http://127.0.0.1:58744');
  assert.equal(ghostex.DEFAULT_TOKEN_PATH, '~/.ghostex/gxserver/auth/token');

  // The cores
  assert.equal(typeof ghostex.GxClient, 'function');
  assert.equal(typeof ghostex.CliTransport, 'function');
  assert.equal(typeof ghostex.RpcTransport, 'function');
  assert.equal(typeof ghostex.GxClientError, 'function');
  assert.equal(typeof ghostex.discoverGhostex, 'function');
  assert.equal(typeof ghostex.probeGhostexHealth, 'function');
  assert.equal(typeof ghostex.readiness, 'function');
  assert.equal(typeof ghostex.GhostexEventStream, 'function');
  assert.equal(typeof ghostex.parseGhostexEvent, 'function');
  assert.equal(typeof ghostex.eventsUrl, 'function');

  // Parse helpers
  assert.equal(typeof ghostex.parseSession, 'function');
  assert.equal(typeof ghostex.parsePresentationSnapshot, 'function');
  assert.equal(ghostex.GhostexParseError.name, 'GhostexParseError');

  // Board-sync engine
  assert.equal(typeof ghostex.planReconcile, 'function');
  assert.equal(typeof ghostex.applyPlan, 'function');
  assert.equal(typeof ghostex.reconcile, 'function');
  assert.equal(typeof ghostex.formatReport, 'function');
  assert.equal(typeof ghostex.defaultBoardStatusMapping.boardToBead, 'function');
  assert.deepEqual(ghostex.DEFAULT_CONFLICT_POLICY, { title: 'lastWriter', status: 'lastWriter' });
});
