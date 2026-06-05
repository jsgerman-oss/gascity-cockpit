/**
 * Endpoint discovery: resolve *which* API the Cockpit should talk to.
 *
 * Precedence (highest first), each rung accepted only after a live `/health`
 * probe confirms it:
 *
 *   1. settings override   — `gascityCockpit.api.url`
 *   2. discovery descriptor — `~/.gc/api.json`, then `<city>/.gc/runtime/api.json`
 *   3. documented default   — `http://127.0.0.1:8372` (supervisor)
 *
 * Probing every candidate means a stale descriptor (e.g. left over from a port
 * that changed across a restart) is skipped automatically. Because the default
 * rung needs no file, discovery succeeds today even though no city writes a
 * descriptor yet — that is the resilience guarantee for this bead.
 */

import {
  DEFAULT_SUPERVISOR_BASE_URL,
  type ApiEndpoint,
  type HealthResponse,
  type Logger,
} from './types.ts';
import { descriptorToEndpoint, normalizeBaseUrl, parseDescriptor } from './descriptor.ts';

/** Read a file's UTF-8 text; reject if it does not exist or cannot be read. */
export type ReadFile = (path: string) => Promise<string>;

/** Probe `/health` at a base URL; resolve with health or reject. */
export type Probe = (baseUrl: string, token: string | null) => Promise<HealthResponse>;

export interface DiscoveryInputs {
  /** Explicit override URL from settings, or null/"" when unset. */
  settingsUrl: string | null;
  /** Optional token from settings (applies to settings URL and default rung). */
  settingsToken: string | null;
  /** Descriptor file paths to try, in order (machine first, then workspace). */
  descriptorPaths: string[];
  /** Default base URL when nothing else resolves. */
  defaultBaseUrl?: string;
  readFile: ReadFile;
  probe: Probe;
  log?: Logger;
}

export interface DiscoveryAttempt {
  readonly source: 'settings' | 'descriptor' | 'default';
  /** The URL probed, or the descriptor path inspected. */
  readonly target: string;
  readonly ok: boolean;
  /** Why this rung was rejected (absent on success). */
  readonly reason?: string;
}

export interface DiscoveryResult {
  readonly ok: boolean;
  readonly endpoint: ApiEndpoint | null;
  /** Every rung tried, in order — feeds the "API unavailable" diagnostics UI. */
  readonly attempts: DiscoveryAttempt[];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function resolveEndpoint(inputs: DiscoveryInputs): Promise<DiscoveryResult> {
  const { settingsToken, descriptorPaths, readFile, probe, log } = inputs;
  const defaultBaseUrl = inputs.defaultBaseUrl ?? DEFAULT_SUPERVISOR_BASE_URL;
  const attempts: DiscoveryAttempt[] = [];

  // Rung 1: explicit settings override.
  const settingsUrl = inputs.settingsUrl?.trim();
  if (settingsUrl) {
    const baseUrl = normalizeBaseUrl(settingsUrl);
    try {
      await probe(baseUrl, settingsToken);
      log?.('info', 'discovery: using settings override', { baseUrl });
      return ok(attempts, { source: 'settings', target: baseUrl, ok: true }, {
        baseUrl,
        token: settingsToken,
        mode: 'unknown',
        source: 'settings',
      });
    } catch (err) {
      attempts.push({ source: 'settings', target: baseUrl, ok: false, reason: errMessage(err) });
      log?.('warn', 'discovery: settings override unreachable, falling through', { baseUrl });
    }
  }

  // Rung 2: discovery descriptor files.
  for (const path of descriptorPaths) {
    let text: string;
    try {
      text = await readFile(path);
    } catch {
      attempts.push({ source: 'descriptor', target: path, ok: false, reason: 'not present' });
      continue;
    }
    let endpoint: ApiEndpoint;
    let token: string | null;
    try {
      const descriptor = parseDescriptor(text);
      endpoint = descriptorToEndpoint(descriptor, 'descriptor');
      token = descriptor.token ?? null;
    } catch (err) {
      attempts.push({ source: 'descriptor', target: path, ok: false, reason: `invalid: ${errMessage(err)}` });
      log?.('warn', 'discovery: descriptor invalid, skipping', { path, reason: errMessage(err) });
      continue;
    }
    try {
      await probe(endpoint.baseUrl, token);
      log?.('info', 'discovery: using descriptor', { path, baseUrl: endpoint.baseUrl });
      attempts.push({ source: 'descriptor', target: path, ok: true });
      return { ok: true, endpoint, attempts };
    } catch (err) {
      attempts.push({
        source: 'descriptor',
        target: path,
        ok: false,
        reason: `unreachable (${endpoint.baseUrl}): ${errMessage(err)}`,
      });
      log?.('warn', 'discovery: descriptor endpoint unreachable (stale?), falling through', {
        path,
        baseUrl: endpoint.baseUrl,
      });
    }
  }

  // Rung 3: documented default.
  const baseUrl = normalizeBaseUrl(defaultBaseUrl);
  try {
    await probe(baseUrl, settingsToken);
    log?.('info', 'discovery: using default supervisor endpoint', { baseUrl });
    return ok(attempts, { source: 'default', target: baseUrl, ok: true }, {
      baseUrl,
      token: settingsToken,
      mode: 'supervisor',
      source: 'default',
    });
  } catch (err) {
    attempts.push({ source: 'default', target: baseUrl, ok: false, reason: errMessage(err) });
  }

  log?.('error', 'discovery: no reachable API endpoint', { attempts: attempts.length });
  return { ok: false, endpoint: null, attempts };
}

function ok(
  attempts: DiscoveryAttempt[],
  finalAttempt: DiscoveryAttempt,
  endpoint: ApiEndpoint,
): DiscoveryResult {
  attempts.push(finalAttempt);
  return { ok: true, endpoint, attempts };
}
