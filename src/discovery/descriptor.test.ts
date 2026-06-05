import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDescriptor,
  cityDescriptorPath,
  descriptorToEndpoint,
  DescriptorError,
  machineDescriptorPath,
  normalizeBaseUrl,
  parseDescriptor,
  serializeDescriptor,
} from './descriptor.ts';

const valid = {
  schema_version: 1,
  base_url: 'http://127.0.0.1:8372',
  scheme: 'http',
  host: '127.0.0.1',
  port: 8372,
  mode: 'supervisor',
  api_version: '0.1.0',
};

test('normalizeBaseUrl strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('http://x:1/'), 'http://x:1');
  assert.equal(normalizeBaseUrl('http://x:1///'), 'http://x:1');
  assert.equal(normalizeBaseUrl('http://x:1'), 'http://x:1');
});

test('parseDescriptor accepts a valid descriptor', () => {
  const d = parseDescriptor(JSON.stringify(valid));
  assert.equal(d.base_url, 'http://127.0.0.1:8372');
  assert.equal(d.port, 8372);
  assert.equal(d.mode, 'supervisor');
  assert.equal(d.token, null); // absent => normalized to null
});

test('parseDescriptor derives base_url when absent from scheme/host/port', () => {
  const { base_url, ...noBase } = valid;
  void base_url;
  const d = parseDescriptor(JSON.stringify(noBase));
  assert.equal(d.base_url, 'http://127.0.0.1:8372');
});

test('parseDescriptor carries optional provenance fields', () => {
  const d = parseDescriptor(
    JSON.stringify({ ...valid, token: 'sek', pid: 4242, build_id: 'abc', started_at: '2026-06-05T06:24:22Z' }),
  );
  assert.equal(d.token, 'sek');
  assert.equal(d.pid, 4242);
  assert.equal(d.build_id, 'abc');
  assert.equal(d.started_at, '2026-06-05T06:24:22Z');
});

test('parseDescriptor rejects malformed JSON', () => {
  assert.throws(() => parseDescriptor('{not json'), DescriptorError);
});

test('parseDescriptor rejects a newer schema version', () => {
  assert.throws(() => parseDescriptor(JSON.stringify({ ...valid, schema_version: 99 })), /newer than supported/);
});

test('parseDescriptor rejects a bad scheme', () => {
  assert.throws(() => parseDescriptor(JSON.stringify({ ...valid, scheme: 'ftp' })), /scheme/);
});

test('parseDescriptor rejects an out-of-range port', () => {
  assert.throws(() => parseDescriptor(JSON.stringify({ ...valid, port: 0 })), /port/);
  assert.throws(() => parseDescriptor(JSON.stringify({ ...valid, port: 70000 })), /port/);
  assert.throws(() => parseDescriptor(JSON.stringify({ ...valid, port: 1.5 })), /port/);
});

test('parseDescriptor rejects a bad mode', () => {
  assert.throws(() => parseDescriptor(JSON.stringify({ ...valid, mode: 'cluster' })), /mode/);
});

test('parseDescriptor rejects a non-string token', () => {
  assert.throws(() => parseDescriptor(JSON.stringify({ ...valid, token: 42 })), /token/);
});

test('descriptorToEndpoint projects with source', () => {
  const ep = descriptorToEndpoint(parseDescriptor(JSON.stringify(valid)), 'descriptor');
  assert.deepEqual(ep, { baseUrl: 'http://127.0.0.1:8372', token: null, mode: 'supervisor', source: 'descriptor' });
});

test('buildDescriptor + serialize + parse round-trips', () => {
  const built = buildDescriptor({ host: '127.0.0.1', port: 9443, mode: 'standalone', api_version: '0.1.0', pid: 7 });
  const text = serializeDescriptor(built);
  assert.match(text, /\n$/); // newline-terminated for atomic write
  const back = parseDescriptor(text);
  assert.equal(back.base_url, 'http://127.0.0.1:9443');
  assert.equal(back.mode, 'standalone');
  assert.equal(back.pid, 7);
});

test('well-known descriptor paths follow gascity conventions', () => {
  assert.equal(machineDescriptorPath('/Users/jayse'), '/Users/jayse/.gc/api.json');
  assert.equal(machineDescriptorPath('/Users/jayse/'), '/Users/jayse/.gc/api.json');
  assert.equal(cityDescriptorPath('/Users/jayse/Code'), '/Users/jayse/Code/.gc/runtime/api.json');
});
