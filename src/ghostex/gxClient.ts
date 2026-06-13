/**
 * A `vscode`-free, typed adapter over Ghostex, with two interchangeable
 * transports behind one {@link GxTransport} interface:
 *
 *   - {@link CliTransport}: shells out to the `gx` CLI with `--json`, mirroring
 *     the `execFile`-a-CLI pattern in `src/views/codeNav.ts` (timeout, bounded
 *     buffer, graceful non-zero-exit / missing-binary handling).
 *   - {@link RpcTransport}: `POST`s to the gxserver daemon
 *     (`http://127.0.0.1:58744/api/<endpoint>`) with the bearer token and the
 *     `x-gxserver-protocol-version` header, unwrapping the
 *     `{ ok, product, protocolVersion, requestId, result }` envelope.
 *
 * {@link GxClient} is transport-agnostic: it maps the high-level methods
 * (listSessions, createAgentSession, sendSessionText, …) onto transport calls
 * and projects the loosely-typed payloads onto the domain types via
 * {@link ./parse.ts}. The transport is injected, so tests drive the client with
 * a fake — no real `gx` binary and no live daemon.
 */

import { execFile } from 'node:child_process';
import {
  parseBoardItems,
  parseLifecycleResult,
  parsePresentationSnapshot,
  parseProjectList,
  parseSession,
  parseSessionList,
  parseSessionText,
  parseJson,
  parseTypedOperationResult,
} from './parse.ts';
import {
  GXSERVER_PRODUCT,
  GXSERVER_PROTOCOL_VERSION,
  type GhostexBoardItem,
  type GhostexPresentationSnapshot,
  type GhostexProject,
  type GhostexSession,
  type GhostexSessionLifecycleResult,
  type GhostexTypedOperationResult,
} from './types.ts';

/** The gxserver RPC endpoints the Cockpit foundation drives. Camel-cased, per the protocol. */
export type GxEndpoint =
  | 'listSessions'
  | 'createSession'
  | 'createAgentSession'
  | 'readSessionText'
  | 'sendSessionText'
  | 'sendSessionMessage'
  | 'requestSessionRename'
  | 'sleepSession'
  | 'wakeSession'
  | 'killSession'
  | 'focusSession'
  | 'listProjects'
  | 'readPresentationSnapshot'
  | 'runBeadsAction'
  | 'runGitAction'
  | 'runWorktreeAction';

/** Loose params bag for a transport call (validated per-method by the caller). */
export type GxParams = Record<string, unknown>;

/**
 * The single seam both transports implement. Given a logical endpoint and its
 * params, return the *unwrapped result payload* (already past the RPC envelope /
 * CLI stdout) as `unknown`, for the client to project. Implementations reject
 * with a {@link GxClientError} on any failure mode.
 */
export interface GxTransport {
  readonly kind: 'cli' | 'rpc';
  call(endpoint: GxEndpoint, params: GxParams): Promise<unknown>;
}

/** Discriminates the failure so callers/UI can react (and tests can assert). */
export type GxErrorCode =
  | 'binaryMissing' // `gx` not on PATH
  | 'timeout' // call exceeded the deadline
  | 'nonZeroExit' // CLI exited non-zero
  | 'unreachable' // daemon refused/network error
  | 'http' // daemon returned a non-2xx
  | 'protocolMismatch' // daemon spoke a different protocol version
  | 'rpcError' // daemon returned `{ ok: false, error }`
  | 'malformedResponse'; // stdout / body was not the promised shape

/** A uniform error across both transports, carrying a machine-readable {@link GxErrorCode}. */
export class GxClientError extends Error {
  constructor(
    readonly code: GxErrorCode,
    message: string,
    /** Transport that produced the error, for diagnostics. */
    readonly transport: 'cli' | 'rpc',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GxClientError';
  }
}

// ---- CLI transport ---------------------------------------------------------

/** Subset of `child_process.execFile` the CLI transport needs (injectable for tests). */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
  callback: (
    error: (Error & { code?: string | number; killed?: boolean }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => void;

export interface CliTransportOptions {
  /** Path to the `gx` binary. Default `"gx"` (resolved on PATH). */
  gxPath?: string;
  /** Per-call timeout (ms). Default 20s. */
  timeoutMs?: number;
  /** Max stdout/stderr bytes before the call is killed. Default 16 MiB. */
  maxBuffer?: number;
  /** Injected `execFile`; defaults to `node:child_process` `execFile`. */
  execFileImpl?: ExecFileLike;
}

/**
 * Map a logical endpoint + params to `gx` CLI argv. Only the methods exercised
 * by the foundation are mapped; the rest fall back to `gx <endpoint>` so the
 * transport degrades predictably rather than throwing for an unmapped verb.
 */
export function cliArgsFor(endpoint: GxEndpoint, params: GxParams): string[] {
  const flag = (key: string, value: unknown): string[] =>
    value === undefined || value === null ? [] : [`--${kebab(key)}`, String(value)];

  switch (endpoint) {
    case 'listSessions':
      return ['sessions'];
    case 'listProjects':
      return ['projects'];
    case 'createSession':
      return [
        'create-session',
        ...flag('projectId', params['projectId']),
        ...flag('title', params['title']),
        ...flag('cwd', params['cwd']),
      ];
    case 'createAgentSession':
      return [
        'create-agent',
        ...flag('projectId', params['projectId']),
        ...flag('agentId', params['agentId']),
        ...flag('title', params['title']),
        ...flag('cwd', params['cwd']),
      ];
    case 'readSessionText':
      return ['read-text', ...flag('sessionId', params['sessionId']), ...flag('projectId', params['projectId'])];
    case 'sendSessionText':
      return [
        'send-text',
        ...flag('sessionId', params['sessionId']),
        ...flag('projectId', params['projectId']),
        ...flag('text', params['text']),
      ];
    case 'sendSessionMessage':
      return [
        'send-message',
        ...flag('sessionId', params['sessionId']),
        ...flag('projectId', params['projectId']),
        ...flag('text', params['text']),
      ];
    case 'requestSessionRename':
      return [
        'rename',
        ...flag('sessionId', params['sessionId']),
        ...flag('projectId', params['projectId']),
        ...flag('title', params['title']),
      ];
    case 'sleepSession':
      return ['sleep', ...flag('sessionId', params['sessionId']), ...flag('projectId', params['projectId'])];
    case 'wakeSession':
      return ['wake', ...flag('sessionId', params['sessionId']), ...flag('projectId', params['projectId'])];
    case 'killSession':
      return ['kill', ...flag('sessionId', params['sessionId']), ...flag('projectId', params['projectId'])];
    case 'focusSession':
      return ['focus', ...flag('sessionId', params['sessionId']), ...flag('projectId', params['projectId'])];
    case 'readPresentationSnapshot':
      return ['snapshot'];
    case 'runBeadsAction':
      return ['beads', ...flag('action', params['action']), ...flag('projectId', params['projectId'])];
    case 'runGitAction':
      return ['git', ...flag('action', params['action']), ...flag('projectId', params['projectId'])];
    case 'runWorktreeAction':
      return ['worktree', ...flag('action', params['action']), ...flag('projectId', params['projectId'])];
    default:
      return [endpoint];
  }
}

/** Transport that drives the `gx` CLI: `execFile('gx', [...args, '--json'])`. */
export class CliTransport implements GxTransport {
  readonly kind = 'cli' as const;
  private readonly gxPath: string;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly execFileImpl: ExecFileLike;

  constructor(options: CliTransportOptions = {}) {
    this.gxPath = options.gxPath ?? 'gx';
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
    this.execFileImpl = options.execFileImpl ?? (execFile as unknown as ExecFileLike);
  }

  call(endpoint: GxEndpoint, params: GxParams): Promise<unknown> {
    const args = [...cliArgsFor(endpoint, params), '--json'];
    return new Promise((resolve, reject) => {
      this.execFileImpl(
        this.gxPath,
        args,
        { timeout: this.timeoutMs, maxBuffer: this.maxBuffer },
        (error, stdout, stderr) => {
          if (error) {
            reject(this.toError(error, stderr, endpoint));
            return;
          }
          try {
            resolve(parseJson(stdout));
          } catch (err) {
            reject(
              new GxClientError(
                'malformedResponse',
                `gx ${endpoint}: ${(err as Error).message}`,
                'cli',
                err,
              ),
            );
          }
        },
      );
    });
  }

  private toError(
    error: Error & { code?: string | number; killed?: boolean },
    stderr: string,
    endpoint: GxEndpoint,
  ): GxClientError {
    // `execFile` reports a missing binary as ENOENT.
    if (error.code === 'ENOENT') {
      return new GxClientError(
        'binaryMissing',
        `gx binary not found (looked for "${this.gxPath}" on PATH)`,
        'cli',
        error,
      );
    }
    if (error.killed || error.code === 'ETIMEDOUT') {
      return new GxClientError(
        'timeout',
        `gx ${endpoint} timed out after ${this.timeoutMs}ms`,
        'cli',
        error,
      );
    }
    const detail = stderr.trim() || error.message;
    return new GxClientError('nonZeroExit', `gx ${endpoint} failed: ${detail}`, 'cli', error);
  }
}

// ---- RPC transport ---------------------------------------------------------

/** Injectable fetch (defaults to global). Mirrors `discovery/health.ts`'s `FetchLike`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RpcTransportOptions {
  /** Base URL of the gxserver daemon. Default `http://127.0.0.1:58744`. */
  baseUrl?: string;
  /** Bearer token sent as `Authorization: Bearer <token>`; null when unset. */
  token?: string | null;
  /** Per-call timeout (ms). Default 20s. */
  timeoutMs?: number;
  /** Injected fetch; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

/** Transport that drives the gxserver RPC over HTTP. */
export class RpcTransport implements GxTransport {
  readonly kind = 'rpc' as const;
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: RpcTransportOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:58744').replace(/\/+$/, '');
    this.token = options.token ?? null;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    if (typeof this.fetchImpl !== 'function') {
      throw new GxClientError('unreachable', 'no fetch implementation available', 'rpc');
    }
  }

  async call(endpoint: GxEndpoint, params: GxParams): Promise<unknown> {
    const url = `${this.baseUrl}/api/${endpoint}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-gxserver-protocol-version': String(GXSERVER_PROTOCOL_VERSION),
    };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    const body = JSON.stringify({ params, protocolVersion: GXSERVER_PROTOCOL_VERSION });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new GxClientError('timeout', `gxserver ${endpoint} timed out after ${this.timeoutMs}ms`, 'rpc', err);
      }
      throw new GxClientError(
        'unreachable',
        `gxserver unreachable at ${this.baseUrl} (${(err as Error).message})`,
        'rpc',
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    return this.unwrap(res, endpoint);
  }

  private async unwrap(res: Response, endpoint: GxEndpoint): Promise<unknown> {
    const text = await res.text();
    let envelope: unknown;
    try {
      envelope = text ? parseJson(text) : {};
    } catch (err) {
      // A non-JSON body on a failing status is an HTTP-level failure (e.g. a
      // proxy/error page), which is the more actionable signal; only a 2xx with
      // a garbage body is a genuine malformed gxserver response.
      if (!res.ok) {
        throw new GxClientError('http', `gxserver ${endpoint} returned HTTP ${res.status}`, 'rpc', err);
      }
      throw new GxClientError(
        'malformedResponse',
        `gxserver ${endpoint}: response was not JSON (HTTP ${res.status})`,
        'rpc',
        err,
      );
    }

    // An error envelope can ride on a 200 or a non-2xx; inspect it either way.
    if (isRpcEnvelope(envelope) && envelope.ok === false) {
      const code = envelope.error === 'protocolMismatch' ? 'protocolMismatch' : 'rpcError';
      throw new GxClientError(
        code,
        `gxserver ${endpoint}: ${envelope.error} — ${envelope.message ?? 'no message'}`,
        'rpc',
      );
    }

    if (!res.ok) {
      throw new GxClientError('http', `gxserver ${endpoint} returned HTTP ${res.status}`, 'rpc');
    }

    if (isRpcEnvelope(envelope) && envelope.ok === true) {
      return envelope.result;
    }
    throw new GxClientError(
      'malformedResponse',
      `gxserver ${endpoint}: response missing the { ok, result } envelope`,
      'rpc',
    );
  }
}

interface RpcEnvelopeShape {
  ok: boolean;
  result?: unknown;
  error?: string;
  message?: string;
  product?: string;
}

function isRpcEnvelope(v: unknown): v is RpcEnvelopeShape {
  return typeof v === 'object' && v !== null && 'ok' in v && typeof (v as { ok: unknown }).ok === 'boolean';
}

// ---- The client ------------------------------------------------------------

/**
 * The typed Ghostex client. Construct with either transport (or a fake), then
 * call the domain methods. Every method projects the transport's `unknown`
 * payload onto a domain type via {@link ./parse.ts}, raising
 * {@link GxClientError} (`malformedResponse`) when a payload is the wrong shape.
 */
export class GxClient {
  constructor(private readonly transport: GxTransport) {}

  /** Build a client over the `gx` CLI transport. */
  static cli(options?: CliTransportOptions): GxClient {
    return new GxClient(new CliTransport(options));
  }

  /** Build a client over the gxserver RPC transport. */
  static rpc(options?: RpcTransportOptions): GxClient {
    return new GxClient(new RpcTransport(options));
  }

  /** Which transport this client drives ("cli" or "rpc"). */
  get transportKind(): 'cli' | 'rpc' {
    return this.transport.kind;
  }

  listSessions(): Promise<GhostexSession[]> {
    return this.project('listSessions', {}, parseSessionList);
  }

  createSession(params: { projectId: string; title?: string; cwd?: string }): Promise<GhostexSession> {
    return this.project('createSession', { ...params }, asSessionResult);
  }

  /**
   * Launch an agent-driven session. `cwd` (optional) sets the session's working
   * directory — the Cockpit's agents-bridge passes the bead's worktree here so the
   * launched agent starts in the right tree; omit it to let Ghostex use the
   * project's default.
   */
  createAgentSession(params: {
    projectId: string;
    agentId: string;
    title?: string;
    cwd?: string;
  }): Promise<GhostexSession> {
    return this.project('createAgentSession', { ...params }, asSessionResult);
  }

  readSessionText(params: { sessionId: string; projectId?: string }): Promise<string> {
    return this.project('readSessionText', { ...params }, parseSessionText);
  }

  sendSessionText(params: { sessionId: string; projectId?: string; text: string }): Promise<void> {
    return this.projectVoid('sendSessionText', { ...params });
  }

  sendSessionMessage(params: {
    sessionId: string;
    projectId?: string;
    text: string;
    /** Append a trailing Enter so the agent submits (gxserver default true). */
    submit?: boolean;
  }): Promise<void> {
    return this.projectVoid('sendSessionMessage', { ...params });
  }

  /**
   * Request a session rename (gxserver `/api/requestSessionRename`). This is the
   * second phase of the agent-session create flow: an agent session is born with
   * an auto-generated first-prompt title, so a caller-chosen title is applied by
   * a follow-up rename. Fire-and-confirm — the (re)named session is already in
   * hand from the create call, so the rename payload is ignored.
   */
  renameSession(params: { projectId: string; sessionId: string; title: string }): Promise<void> {
    return this.projectVoid('requestSessionRename', { ...params });
  }

  sleepSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult> {
    return this.project('sleepSession', { ...params }, parseLifecycleResult);
  }

  wakeSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult> {
    return this.project('wakeSession', { ...params }, parseLifecycleResult);
  }

  killSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult> {
    return this.project('killSession', { ...params }, parseLifecycleResult);
  }

  focusSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult> {
    return this.project('focusSession', { ...params }, parseLifecycleResult);
  }

  listProjects(): Promise<GhostexProject[]> {
    return this.project('listProjects', {}, parseProjectList);
  }

  readPresentationSnapshot(): Promise<GhostexPresentationSnapshot> {
    return this.project('readPresentationSnapshot', {}, parsePresentationSnapshot);
  }

  runBeadsAction(params: { action: string; projectId?: string } & GxParams): Promise<GhostexBoardItem[]> {
    // The `board` action returns issues; other actions return a typed op result.
    // We always surface board items, projecting `[]` when there are none.
    return this.project('runBeadsAction', { ...params }, parseBoardItems);
  }

  runGitAction(params: { action: string; projectId?: string } & GxParams): Promise<GhostexTypedOperationResult> {
    return this.project('runGitAction', { ...params }, parseTypedOperationResult);
  }

  runWorktreeAction(
    params: { action: string; projectId?: string } & GxParams,
  ): Promise<GhostexTypedOperationResult> {
    return this.project('runWorktreeAction', { ...params }, parseTypedOperationResult);
  }

  /** Call the transport and project the result, normalizing projection failures. */
  private async project<T>(
    endpoint: GxEndpoint,
    params: GxParams,
    projector: (raw: unknown) => T,
  ): Promise<T> {
    const raw = await this.transport.call(endpoint, params);
    try {
      return projector(raw);
    } catch (err) {
      throw new GxClientError(
        'malformedResponse',
        `${endpoint}: ${(err as Error).message}`,
        this.transport.kind,
        err,
      );
    }
  }

  /** Fire-and-confirm: call the transport, ignore the (often empty) payload. */
  private async projectVoid(endpoint: GxEndpoint, params: GxParams): Promise<void> {
    await this.transport.call(endpoint, params);
  }
}

/** Project a create/lifecycle payload to a session, tolerating `{ session }` or a bare session. */
function asSessionResult(raw: unknown): GhostexSession {
  if (typeof raw === 'object' && raw !== null && 'session' in raw) {
    return parseSession((raw as { session: unknown }).session);
  }
  return parseSession(raw);
}

/** camelCase → kebab-case for CLI flag names (`projectId` → `project-id`). */
function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

// Re-export so `GXSERVER_PRODUCT` is reachable from the client barrel without a
// second import in consumers that assert the product identity.
export { GXSERVER_PRODUCT };
