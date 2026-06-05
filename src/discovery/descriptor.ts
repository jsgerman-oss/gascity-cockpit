/**
 * The discovery descriptor: parse + validate (extension/consumer side) and
 * build + serialize (pack/producer side reference). Both ends share one schema
 * so the contract is concrete, not prose.
 */

import {
  DESCRIPTOR_SCHEMA_VERSION,
  type ApiDescriptor,
  type ApiEndpoint,
  type DiscoverySource,
} from './types.ts';

/** Thrown when a descriptor file is present but malformed. */
export class DescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DescriptorError';
  }
}

/** Strip a single trailing slash so base URLs concatenate predictably. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse and validate descriptor JSON. Throws `DescriptorError` on any structural
 * problem so the discovery chain can record the reason and fall through to the
 * next candidate rather than accept a half-valid descriptor.
 */
export function parseDescriptor(text: string): ApiDescriptor {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new DescriptorError(`invalid JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(raw)) {
    throw new DescriptorError('descriptor must be a JSON object');
  }

  const schemaVersion = raw['schema_version'];
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw new DescriptorError('schema_version must be an integer');
  }
  if (schemaVersion > DESCRIPTOR_SCHEMA_VERSION) {
    throw new DescriptorError(
      `descriptor schema_version ${schemaVersion} is newer than supported ${DESCRIPTOR_SCHEMA_VERSION}; upgrade the extension`,
    );
  }

  const scheme = raw['scheme'];
  if (scheme !== 'http' && scheme !== 'https') {
    throw new DescriptorError(`scheme must be "http" or "https", got ${JSON.stringify(scheme)}`);
  }

  const host = raw['host'];
  if (typeof host !== 'string' || host.length === 0) {
    throw new DescriptorError('host must be a non-empty string');
  }

  const port = raw['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DescriptorError(`port must be an integer in 1..65535, got ${JSON.stringify(port)}`);
  }

  const mode = raw['mode'];
  if (mode !== 'supervisor' && mode !== 'standalone') {
    throw new DescriptorError(`mode must be "supervisor" or "standalone", got ${JSON.stringify(mode)}`);
  }

  const apiVersion = raw['api_version'];
  if (typeof apiVersion !== 'string' || apiVersion.length === 0) {
    throw new DescriptorError('api_version must be a non-empty string');
  }

  // base_url is authoritative if present and well-formed; otherwise derive it.
  let baseUrl: string;
  const rawBase = raw['base_url'];
  if (typeof rawBase === 'string' && rawBase.length > 0) {
    baseUrl = normalizeBaseUrl(rawBase);
  } else {
    baseUrl = `${scheme}://${host}:${port}`;
  }

  const token = raw['token'];
  if (token !== undefined && token !== null && typeof token !== 'string') {
    throw new DescriptorError('token must be a string, null, or absent');
  }

  const descriptor: ApiDescriptor = {
    schema_version: schemaVersion,
    base_url: baseUrl,
    scheme,
    host,
    port,
    mode,
    api_version: apiVersion,
    token: token ?? null,
  };

  // Optional provenance fields — copied through only when well-typed.
  const pid = raw['pid'];
  if (typeof pid === 'number' && Number.isInteger(pid)) descriptor.pid = pid;
  const buildId = raw['build_id'];
  if (typeof buildId === 'string') descriptor.build_id = buildId;
  const startedAt = raw['started_at'];
  if (typeof startedAt === 'string') descriptor.started_at = startedAt;

  return descriptor;
}

/** Project a validated descriptor onto a usable endpoint. */
export function descriptorToEndpoint(d: ApiDescriptor, source: DiscoverySource): ApiEndpoint {
  return {
    baseUrl: normalizeBaseUrl(d.base_url),
    token: d.token ?? null,
    mode: d.mode,
    source,
  };
}

/** Options for building a descriptor on the producer (pack) side. */
export interface BuildDescriptorOptions {
  scheme?: 'http' | 'https';
  host: string;
  port: number;
  mode: 'supervisor' | 'standalone';
  api_version: string;
  token?: string | null;
  pid?: number;
  build_id?: string;
  started_at?: string;
}

/**
 * Reference producer: build a well-formed descriptor. Provided so the pack (or a
 * Node-based test fixture) can emit exactly what the extension expects from one
 * shared definition.
 */
export function buildDescriptor(opts: BuildDescriptorOptions): ApiDescriptor {
  const scheme = opts.scheme ?? 'http';
  const d: ApiDescriptor = {
    schema_version: DESCRIPTOR_SCHEMA_VERSION,
    base_url: `${scheme}://${opts.host}:${opts.port}`,
    scheme,
    host: opts.host,
    port: opts.port,
    mode: opts.mode,
    api_version: opts.api_version,
    token: opts.token ?? null,
  };
  if (opts.pid !== undefined) d.pid = opts.pid;
  if (opts.build_id !== undefined) d.build_id = opts.build_id;
  if (opts.started_at !== undefined) d.started_at = opts.started_at;
  return d;
}

/** Serialize a descriptor for atomic write (newline-terminated, stable order). */
export function serializeDescriptor(d: ApiDescriptor): string {
  return JSON.stringify(d, null, 2) + '\n';
}

/** Path segment of the descriptor relative to a `.gc` directory. */
export const DESCRIPTOR_FILENAME = 'api.json';

/**
 * Well-known path of the machine-wide supervisor descriptor: alongside
 * `cities.toml` and `supervisor.sock` in the user's `~/.gc` directory.
 *
 * @param homeDir absolute path to the user's home directory (`os.homedir()`).
 */
export function machineDescriptorPath(homeDir: string): string {
  return joinPath(homeDir, '.gc', DESCRIPTOR_FILENAME);
}

/**
 * Well-known path of a standalone city's descriptor: under the city's
 * `.gc/runtime` directory (mirrors where packs write runtime state today).
 *
 * @param cityRoot absolute path to the city directory.
 */
export function cityDescriptorPath(cityRoot: string): string {
  return joinPath(cityRoot, '.gc', 'runtime', DESCRIPTOR_FILENAME);
}

/**
 * Minimal POSIX-style path join (no `node:path` dependency, so this module stays
 * trivially testable and portable). Collapses duplicate separators between
 * segments and preserves a leading "/".
 */
function joinPath(...segments: string[]): string {
  return segments
    .map((s, i) => (i === 0 ? s.replace(/\/+$/, '') : s.replace(/^\/+|\/+$/g, '')))
    .filter((s) => s.length > 0)
    .join('/');
}
