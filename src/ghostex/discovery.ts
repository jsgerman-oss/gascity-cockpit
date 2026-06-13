/**
 * Ghostex discovery: resolve *whether* and *where* a gxserver daemon is, and
 * whether the Cockpit can actually talk to it. Mirrors the supervisor discovery
 * pattern in `src/discovery/` but for the gxserver contract:
 *
 *   - Resolve a base URL — settings override, else the documented local default
 *     (`http://127.0.0.1:58744`).
 *   - Resolve a bearer token — settings override, else read the local token file
 *     (`~/.ghostex/gxserver/auth/token`, overridable), tolerating its absence.
 *   - Probe `/api/health` for liveness, then negotiate the protocol version
 *     (`protocolVersion === 1`); a mismatch is a hard failure (the contract says
 *     "ask the user to update", never fall back).
 *   - Expose a `connected` / `unavailable` outcome plus a {@link readiness}
 *     assertion that returns actionable diagnostics for the "Ghostex unavailable"
 *     UI.
 *
 * `vscode`-free: `fetch` and the token-file reader are injected, so the whole
 * thing is unit-testable with no sockets and no filesystem.
 */

import { parseHealth, parseServerHealth } from './parse.ts';
import {
  DEFAULT_GXSERVER_BASE_URL,
  DEFAULT_TOKEN_PATH,
  GXSERVER_PROTOCOL_VERSION,
  type GhostexHealth,
  type GhostexServerHealth,
} from './types.ts';

/** Read a file's UTF-8 text; reject when it does not exist or cannot be read. */
export type ReadTokenFile = (path: string) => Promise<string>;

/** Injectable fetch (defaults to global), matching the rest of the cores. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Severity for the optional injected logger (matches `discovery/types.ts`). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;

/** Why discovery could not produce a usable connection — drives the diagnostics UI. */
export type GhostexUnavailableReason =
  | 'unreachable' // no daemon answered `/api/health`
  | 'http' // `/api/health` answered non-2xx
  | 'malformedHealth' // `/api/health` body was not the promised shape
  | 'protocolMismatch' // daemon spoke a different protocol version
  | 'notGxserver'; // answered, but did not identify as gxserver

export interface GhostexDiscoveryInputs {
  /** Explicit base-URL override (settings), or null/"" to use the default. */
  settingsUrl?: string | null;
  /** Explicit token override (settings), or null/"" to read the token file. */
  settingsToken?: string | null;
  /** Default base URL when no override is set. */
  defaultBaseUrl?: string;
  /**
   * Resolved absolute path of the token file. Defaults to the documented
   * tilde-path; callers expand `~` (this core never touches the home dir).
   */
  tokenPath?: string;
  /** Read the token file; required to resolve a token from disk. */
  readTokenFile?: ReadTokenFile;
  /** Health-probe timeout (ms). Default 3000. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  log?: Logger;
}

/** A resolved, probed gxserver endpoint — only produced after a healthy probe. */
export interface GhostexEndpoint {
  readonly baseUrl: string;
  readonly token: string | null;
  /** Where the base URL came from. */
  readonly source: 'settings' | 'default';
  /** Where the token came from. */
  readonly tokenSource: 'settings' | 'file' | 'none';
}

/** The outcome of {@link discoverGhostex}: connected (with endpoint+health) or not. */
export type GhostexDiscovery =
  | {
      readonly state: 'connected';
      readonly endpoint: GhostexEndpoint;
      readonly health: GhostexHealth;
    }
  | {
      readonly state: 'unavailable';
      readonly reason: GhostexUnavailableReason;
      /** Human-readable, actionable detail for the UI. */
      readonly detail: string;
      /** The base URL that was probed, for the diagnostics line. */
      readonly baseUrl: string;
    };

/** Thrown by {@link probeGhostexHealth} for any non-success probe outcome. */
export class GhostexProbeError extends Error {
  constructor(
    readonly reason: GhostexUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'GhostexProbeError';
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * GET `<baseUrl>/api/health` with a hard timeout, returning parsed health.
 * Rejects with {@link GhostexProbeError} (carrying a typed reason) for every
 * failure mode so the caller can map it straight onto the diagnostics UI.
 */
export async function probeGhostexHealth(
  baseUrl: string,
  options: { token?: string | null; timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<GhostexHealth> {
  const { token = null, timeoutMs = 3000, fetchImpl = globalThis.fetch as FetchLike } = options;
  if (typeof fetchImpl !== 'function') {
    throw new GhostexProbeError('unreachable', 'no fetch implementation available');
  }
  const url = `${stripTrailingSlash(baseUrl)}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) {
      throw new GhostexProbeError('http', `gxserver /api/health returned HTTP ${res.status}`);
    }
    let health: GhostexHealth;
    try {
      health = parseHealth(JSON.parse(await res.text()));
    } catch (err) {
      throw new GhostexProbeError('malformedHealth', `gxserver /api/health: ${(err as Error).message}`);
    }
    if (health.product && health.product !== 'gxserver') {
      throw new GhostexProbeError(
        'notGxserver',
        `endpoint at ${baseUrl} is not gxserver (product="${health.product}")`,
      );
    }
    if (health.protocolVersion !== GXSERVER_PROTOCOL_VERSION) {
      throw new GhostexProbeError(
        'protocolMismatch',
        `gxserver protocol mismatch: this Cockpit speaks ${GXSERVER_PROTOCOL_VERSION}, ` +
          `daemon speaks ${health.protocolVersion}. Update Ghostex and the Cockpit so they match.`,
      );
    }
    return health;
  } catch (err) {
    if (err instanceof GhostexProbeError) throw err;
    if (controller.signal.aborted) {
      throw new GhostexProbeError('unreachable', `gxserver /api/health timed out after ${timeoutMs}ms`);
    }
    throw new GhostexProbeError(
      'unreachable',
      `gxserver unreachable at ${baseUrl} (${(err as Error).message})`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET `<baseUrl>/api/health/server` — the authenticated, detailed health. Used
 * once connected (e.g. to read `buildIdentity` for restart detection). Requires
 * a token; rejects with {@link GhostexProbeError} on any failure.
 */
export async function probeGhostexServerHealth(
  baseUrl: string,
  options: { token: string; timeoutMs?: number; fetchImpl?: FetchLike },
): Promise<GhostexServerHealth> {
  const { token, timeoutMs = 3000, fetchImpl = globalThis.fetch as FetchLike } = options;
  if (typeof fetchImpl !== 'function') {
    throw new GhostexProbeError('unreachable', 'no fetch implementation available');
  }
  const url = `${stripTrailingSlash(baseUrl)}/api/health/server`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'x-gxserver-protocol-version': String(GXSERVER_PROTOCOL_VERSION),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new GhostexProbeError('http', `gxserver /api/health/server returned HTTP ${res.status}`);
    }
    try {
      return parseServerHealth(JSON.parse(await res.text()));
    } catch (err) {
      throw new GhostexProbeError('malformedHealth', `gxserver /api/health/server: ${(err as Error).message}`);
    }
  } catch (err) {
    if (err instanceof GhostexProbeError) throw err;
    if (controller.signal.aborted) {
      throw new GhostexProbeError('unreachable', `gxserver /api/health/server timed out after ${timeoutMs}ms`);
    }
    throw new GhostexProbeError('unreachable', `gxserver unreachable at ${baseUrl} (${(err as Error).message})`);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the bearer token: settings override wins; else read the token file. */
async function resolveToken(
  inputs: GhostexDiscoveryInputs,
): Promise<{ token: string | null; source: GhostexEndpoint['tokenSource'] }> {
  const fromSettings = inputs.settingsToken?.trim();
  if (fromSettings) return { token: fromSettings, source: 'settings' };

  const read = inputs.readTokenFile;
  if (read) {
    const path = inputs.tokenPath ?? DEFAULT_TOKEN_PATH;
    try {
      const raw = (await read(path)).trim();
      if (raw) return { token: raw, source: 'file' };
    } catch {
      // Absent/unreadable token file is fine — many local setups are open.
      inputs.log?.('debug', 'ghostex discovery: no token file', { path });
    }
  }
  return { token: null, source: 'none' };
}

/**
 * Resolve and probe a gxserver endpoint. Returns a `connected` outcome with the
 * resolved endpoint + health, or an `unavailable` outcome with a typed reason
 * and actionable detail. Never throws for an expected "daemon not running" case.
 */
export async function discoverGhostex(inputs: GhostexDiscoveryInputs): Promise<GhostexDiscovery> {
  const settingsUrl = inputs.settingsUrl?.trim();
  const baseUrl = stripTrailingSlash(settingsUrl || inputs.defaultBaseUrl || DEFAULT_GXSERVER_BASE_URL);
  const source: GhostexEndpoint['source'] = settingsUrl ? 'settings' : 'default';

  const { token, source: tokenSource } = await resolveToken(inputs);

  try {
    const health = await probeGhostexHealth(baseUrl, {
      token,
      ...(inputs.timeoutMs !== undefined ? { timeoutMs: inputs.timeoutMs } : {}),
      ...(inputs.fetchImpl ? { fetchImpl: inputs.fetchImpl } : {}),
    });
    inputs.log?.('info', 'ghostex discovery: connected', { baseUrl, source, tokenSource });
    return {
      state: 'connected',
      endpoint: { baseUrl, token, source, tokenSource },
      health,
    };
  } catch (err) {
    const probe = err instanceof GhostexProbeError ? err : new GhostexProbeError('unreachable', String(err));
    inputs.log?.('warn', 'ghostex discovery: unavailable', { baseUrl, reason: probe.reason });
    return {
      state: 'unavailable',
      reason: probe.reason,
      detail: actionableDetail(probe.reason, baseUrl, probe.message),
      baseUrl,
    };
  }
}

/** Turn a typed reason into a one-line, actionable diagnostic for the UI. */
function actionableDetail(reason: GhostexUnavailableReason, baseUrl: string, message: string): string {
  switch (reason) {
    case 'unreachable':
      return `No gxserver daemon answered at ${baseUrl}. Is Ghostex running? Start it, or set "gascityCockpit.ghostex.gxserverUrl".`;
    case 'http':
      return `${message}. The daemon answered but rejected the health probe — check it is a gxserver listener.`;
    case 'malformedHealth':
      return `${message}. The endpoint at ${baseUrl} did not return a gxserver health body — wrong port or service?`;
    case 'protocolMismatch':
      return message; // already actionable ("update Ghostex and the Cockpit").
    case 'notGxserver':
      return `${message}. Point "gascityCockpit.ghostex.gxserverUrl" at the gxserver daemon (default ${DEFAULT_GXSERVER_BASE_URL}).`;
  }
}

/**
 * A readiness assertion over a discovery outcome: `ok` plus a list of
 * human-readable diagnostics. On a `connected` outcome `ok` is true with no
 * diagnostics; on `unavailable` it is false with the actionable detail. This is
 * what a feature calls before driving Ghostex, to short-circuit with a message
 * the operator can act on.
 */
export interface GhostexReadiness {
  readonly ok: boolean;
  readonly reason?: GhostexUnavailableReason;
  readonly diagnostics: readonly string[];
  readonly endpoint?: GhostexEndpoint;
}

export function readiness(discovery: GhostexDiscovery): GhostexReadiness {
  if (discovery.state === 'connected') {
    return { ok: true, diagnostics: [], endpoint: discovery.endpoint };
  }
  return { ok: false, reason: discovery.reason, diagnostics: [discovery.detail] };
}
