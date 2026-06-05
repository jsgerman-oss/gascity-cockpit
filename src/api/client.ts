// Typed client over the gascity supervisor /v0 HTTP API.
//
// This is the single seam the rest of the Cockpit talks to the API through
// (PRD Testing Decisions, Seam 1). It is provider-agnostic — no `vscode`
// imports — so it can be unit-tested against an OpenAPI-conformant mock server.
import createClient from "openapi-fetch";
import type { paths } from "./generated/v0";
import type { ApiErrorModel } from "./types";

/** The typed openapi-fetch client, parameterised by the generated /v0 paths. */
export type CockpitClient = ReturnType<typeof createClient<paths>>;

export interface CockpitClientOptions {
  /** Base URL of the supervisor, e.g. `http://127.0.0.1:8372`. */
  baseUrl: string;
  /**
   * Fetch implementation. Defaults to the global `fetch`. Injecting a fetch is
   * how tests drive the client against a mock /v0 server without real sockets.
   */
  fetch?: typeof fetch;
  /** Extra headers sent on every request (e.g. future auth tokens). */
  headers?: Record<string, string>;
  /**
   * Per-request timeout in milliseconds. `0` or omitted disables the timeout.
   * Streaming endpoints (SSE) bypass this client and are not affected.
   */
  timeoutMs?: number;
}

/** Trailing slashes break openapi-fetch path joining; strip them once here. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Wrap a fetch so each call aborts after `timeoutMs`, while still honouring a
 * caller-supplied `signal`. Returns the fetch unchanged when no timeout is set.
 */
export function withTimeout(baseFetch: typeof fetch, timeoutMs?: number): typeof fetch {
  if (!timeoutMs || timeoutMs <= 0) {
    return baseFetch;
  }
  return (input, init) => {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    // A caller's signal may arrive via `init` or be baked into a Request input
    // (openapi-fetch builds a Request and calls `fetch(request)`); honour both.
    if (init?.signal) {
      signals.push(init.signal);
    } else if (input instanceof Request && input.signal) {
      signals.push(input.signal);
    }
    return baseFetch(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

/** Construct a typed /v0 client. */
export function createCockpitClient(options: CockpitClientOptions): CockpitClient {
  const baseFetch = options.fetch ?? globalThis.fetch;
  return createClient<paths>({
    baseUrl: normalizeBaseUrl(options.baseUrl),
    fetch: withTimeout(baseFetch, options.timeoutMs),
    headers: { Accept: "application/json", ...options.headers },
  });
}

/**
 * The `Authorization` header bag for a bearer token, or `undefined` when there
 * is no token (so it spreads/assigns to nothing on the unauthenticated path).
 *
 * This is the single place the Cockpit constructs the `Bearer` scheme for /v0
 * clients and streams — every request/response client (`createCockpitClient`),
 * the chat panel, and the SSE readers thread their token through here. It is the
 * one injection point a future auth model would change: when the token stops
 * being a single shared secret and becomes issued/scoped/rotated credentials,
 * its *contents* change but this seam does not move (see docs/remote-and-auth.md).
 *
 * The discovery-layer `/health` probe (`src/discovery/health.ts`) deliberately
 * carries its own header and does not import this, keeping discovery free of an
 * `src/api` dependency.
 */
export function bearerAuthHeader(token?: string | null): Record<string, string> | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/** A request id the supervisor stamps on every response, for log correlation. */
export const REQUEST_ID_HEADER = "X-GC-Request-Id";

/**
 * Anti-CSRF header the supervisor requires on every mutating request
 * (POST/PATCH/DELETE). The server only checks the header is present and
 * non-empty — the value itself is not validated.
 */
export const CSRF_HEADER = "X-GC-Request";

/**
 * Header bag carrying the anti-CSRF header, to spread into a mutation's typed
 * `params.header`. openapi-fetch types every mutation as requiring this header,
 * so call sites cannot forget it; this keeps the value in one place for all
 * feature modules that issue writes (approvals, beads CRUD, chat submit, …).
 */
export function csrfHeader(value = "cockpit"): { "X-GC-Request": string } {
  return { "X-GC-Request": value };
}

/** Normalised, display-ready error derived from an openapi-fetch failure. */
export interface NormalizedError {
  /** HTTP status code, or 0 when the request never completed (network/abort). */
  status: number;
  /** Short summary suitable for a notification title. */
  title: string;
  /** Longer explanation, when the server provided one. */
  detail?: string;
  /** Supervisor request id from the response headers, for log correlation. */
  requestId?: string;
  /** The raw error body or thrown value, for logging. */
  raw?: unknown;
}

function isErrorModel(value: unknown): value is ApiErrorModel {
  return typeof value === "object" && value !== null && "type" in value;
}

/**
 * Turn the `{ error, response }` of a failed openapi-fetch call — or a thrown
 * network/abort error — into a single uniform shape for the UI and logs.
 */
export function normalizeError(error: unknown, response?: Response): NormalizedError {
  const requestId = response?.headers.get(REQUEST_ID_HEADER) ?? undefined;

  if (isErrorModel(error)) {
    return {
      status: error.status ?? response?.status ?? 0,
      title: error.title ?? response?.statusText ?? "Request failed",
      detail: error.detail,
      requestId,
      raw: error,
    };
  }

  if (error instanceof Error) {
    const aborted = error.name === "AbortError" || error.name === "TimeoutError";
    return {
      status: response?.status ?? 0,
      title: aborted ? "Request timed out" : "Network error",
      detail: error.message,
      requestId,
      raw: error,
    };
  }

  return {
    status: response?.status ?? 0,
    title: response?.statusText || "Request failed",
    requestId,
    raw: error,
  };
}
