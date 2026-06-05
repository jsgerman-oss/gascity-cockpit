/**
 * Liveness probe against the unversioned top-level `/health` endpoint. This is
 * the single signal the resilience layer uses to decide "is the API there, and
 * is it ready?".
 */

import type { HealthResponse } from './types.ts';
import { normalizeBaseUrl } from './descriptor.ts';

/** Thrown when `/health` is reachable but returns an unexpected body. */
export class HealthParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealthParseError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Parse a `/health` body into a `HealthResponse`. Tolerant of missing optional
 * fields (older/newer servers), strict about the one field that matters:
 * `status`. The `startup` block defaults to "ready" when absent so servers that
 * predate the startup phase reporting are still treated as usable.
 */
export function parseHealth(text: string): HealthResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new HealthParseError(`invalid JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(raw)) {
    throw new HealthParseError('health response must be a JSON object');
  }
  const status = raw['status'];
  if (typeof status !== 'string' || status.length === 0) {
    throw new HealthParseError('health.status must be a non-empty string');
  }

  const startupRaw = raw['startup'];
  const startup = isPlainObject(startupRaw) ? startupRaw : {};
  const phasesRaw = startup['phases_completed'];

  return {
    status,
    version: typeof raw['version'] === 'string' ? (raw['version'] as string) : 'unknown',
    build_id: typeof raw['build_id'] === 'string' ? (raw['build_id'] as string) : '',
    uptime_sec: num(raw['uptime_sec']),
    cities_total: num(raw['cities_total']),
    cities_running: num(raw['cities_running']),
    startup: {
      // Absent startup block => assume ready (server predates phase reporting).
      ready: typeof startup['ready'] === 'boolean' ? (startup['ready'] as boolean) : true,
      phase: typeof startup['phase'] === 'string' ? (startup['phase'] as string) : 'running',
      phases_completed: Array.isArray(phasesRaw) ? (phasesRaw as unknown[]).map(String) : [],
    },
  };
}

/** True when the server is serving and fully started. */
export function isHealthy(h: HealthResponse): boolean {
  return h.status === 'ok' && h.startup.ready === true;
}

/** Injectable fetch (defaults to global). Lets tests run without real sockets. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProbeOptions {
  token?: string | null;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Optional caller-supplied abort signal, combined with the timeout. */
  signal?: AbortSignal;
}

/** Thrown when the probe cannot complete (network error, timeout, non-2xx). */
export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

/**
 * GET `<baseUrl>/health` with a hard timeout, returning the parsed health.
 * Rejects with `ProbeError` for any failure mode (unreachable, timeout, non-2xx,
 * unparseable) so callers can treat "could not confirm liveness" uniformly.
 */
export async function probeHealth(baseUrl: string, options: ProbeOptions = {}): Promise<HealthResponse> {
  const { token = null, timeoutMs = 3000, fetchImpl = globalThis.fetch as FetchLike, signal } = options;
  if (typeof fetchImpl !== 'function') {
    throw new ProbeError('no fetch implementation available');
  }
  const url = `${normalizeBaseUrl(baseUrl)}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ProbeError(`health probe timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) {
      throw new ProbeError(`health returned HTTP ${res.status}`);
    }
    const body = await res.text();
    return parseHealth(body);
  } catch (err) {
    if (err instanceof ProbeError || err instanceof HealthParseError) {
      throw err instanceof ProbeError ? err : new ProbeError(err.message);
    }
    throw new ProbeError(`health probe failed: ${(err as Error).message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
