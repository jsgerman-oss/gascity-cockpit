/**
 * Shared types for API discovery + the resilience (connection) contract.
 *
 * This module is the single source of truth for the shapes the Cockpit and the
 * city-side pack agree on. It is intentionally free of any `vscode` import so it
 * can be unit-tested without an editor (PRD "Seam 1").
 */

/** An RFC3339 / ISO-8601 timestamp string, e.g. "2026-06-05T06:24:22Z". */
export type Timestamp = string;

/**
 * Deployment mode of the API the Cockpit talks to.
 *
 * - `supervisor`: the machine-wide `gc` supervisor API (default `:8372`),
 *   serving every managed city under `/v0/city/{name}/...`.
 * - `standalone`: a single city started with `gc start` exposing its own
 *   `[api]` listener from `city.toml`.
 * - `unknown`: mode could not be determined (e.g. default fallback before a
 *   `/v0/cities` probe).
 */
export type ApiMode = 'supervisor' | 'standalone' | 'unknown';

/** Where a resolved endpoint came from, for diagnostics and UI. */
export type DiscoverySource = 'settings' | 'descriptor' | 'default';

/**
 * A resolved, *probed* API endpoint the Cockpit can use. An `ApiEndpoint` is
 * only ever produced after a successful `/health` probe, so holding one implies
 * the API was reachable at resolution time (liveness is still re-verified by the
 * connection manager).
 */
export interface ApiEndpoint {
  /** Base URL with no trailing slash, e.g. "http://127.0.0.1:8372". */
  readonly baseUrl: string;
  /** Bearer token for `Authorization`, or null when unauthenticated. */
  readonly token: string | null;
  /** Supervisor vs standalone city. */
  readonly mode: ApiMode;
  /** Which discovery rung produced this endpoint. */
  readonly source: DiscoverySource;
}

/**
 * The discovery descriptor a Cockpit-ready city/pack writes to a well-known path
 * so the extension can find the API without inspection or hard-coding.
 *
 * Field naming mirrors existing gascity runtime-state JSON (snake_case keys,
 * RFC3339 timestamps — cf. `.gc/runtime/packs/dolt/dolt-state.json`).
 *
 * PROPOSED contract (pending ratification — see
 * docs/api-discovery-and-resilience.md). Today no city writes this file; the
 * extension degrades to the documented default `:8372`.
 */
export interface ApiDescriptor {
  /** Descriptor schema version; bumped on breaking changes. Current: 1. */
  schema_version: number;
  /** Full base URL, no trailing slash, e.g. "http://127.0.0.1:8372". */
  base_url: string;
  /** URL scheme. */
  scheme: 'http' | 'https';
  /** Bind host, e.g. "127.0.0.1". */
  host: string;
  /** TCP port the API listens on. */
  port: number;
  /** Deployment mode. */
  mode: 'supervisor' | 'standalone';
  /** `/v0` API version (OpenAPI `info.version`) for compatibility assertion. */
  api_version: string;
  /** Optional local bearer token; null/absent when unauthenticated. */
  token?: string | null;
  /** PID of the supervisor/controller that owns this listener. */
  pid?: number;
  /** Server build identifier, used for restart detection. */
  build_id?: string;
  /** When the listener started (RFC3339). */
  started_at?: Timestamp;
}

/** Current descriptor schema version understood by this extension. */
export const DESCRIPTOR_SCHEMA_VERSION = 1;

/** The documented default supervisor API base URL (no addr file required). */
export const DEFAULT_SUPERVISOR_BASE_URL = 'http://127.0.0.1:8372';

/**
 * Response shape of the unversioned, top-level `/health` endpoint — the stable
 * liveness + readiness + identity probe the resilience layer is built on.
 */
export interface HealthResponse {
  /** "ok" when serving. */
  status: string;
  /** Server semantic version or "dev". */
  version: string;
  /** Build identifier; changes across a rebuild/restart. */
  build_id: string;
  /** Seconds since the API process started. */
  uptime_sec: number;
  /** Total managed cities. */
  cities_total: number;
  /** Currently running cities. */
  cities_running: number;
  /** Startup progress; `ready=false` means up-but-still-initializing. */
  startup: HealthStartup;
}

export interface HealthStartup {
  ready: boolean;
  phase: string;
  phases_completed: string[];
}

/**
 * Lifecycle state of the Cockpit's connection to the API. Surfaced to the UI so
 * the operator always knows whether the Cockpit is live, starting, retrying, or
 * gave up.
 *
 * - `idle`          — manager constructed, not started.
 * - `discovering`   — resolving an endpoint (descriptor / settings / default).
 * - `connecting`    — probing `/health` on a resolved endpoint.
 * - `connected`     — healthy and `startup.ready === true`.
 * - `degraded`      — reachable but `startup.ready === false` (still starting).
 * - `reconnecting`  — connection lost; backing off and will re-discover.
 * - `unavailable`   — no endpoint reachable after attempts; explicit dead state
 *                     (the manager keeps retrying at the backoff ceiling).
 */
export type ConnectionState =
  | 'idle'
  | 'discovering'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'reconnecting'
  | 'unavailable';

/** A point-in-time snapshot of the connection, emitted on every change. */
export interface ConnectionStatus {
  readonly state: ConnectionState;
  /** The active endpoint, when one is resolved. */
  readonly endpoint: ApiEndpoint | null;
  /** Latest successful health snapshot, when available. */
  readonly health: HealthResponse | null;
  /** Consecutive failed attempts since the last success (drives backoff). */
  readonly failedAttempts: number;
  /** Human-readable detail for the UI (last error / phase / source). */
  readonly detail: string;
  /**
   * Set on the first connected status after a server restart was detected
   * (build_id changed across a reconnect). Consumers (SSE subscribers, caches)
   * should treat this as "resubscribe / invalidate".
   */
  readonly restarted: boolean;
}

/** Severity for the injected logger. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Minimal structured logger the core modules write to (injected). */
export type Logger = (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;
