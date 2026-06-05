// A uniform result shape for /v0 domain operations.
//
// The raw openapi-fetch client returns `{ data, error, response }` and lets
// network/abort rejections propagate (see version.ts). Feature modules
// (approvals, beads, sessions, …) instead want one predictable value they can
// branch on without try/catch at every call site. `runApi` collapses both the
// `{ data, error }` outcome and a thrown network/abort error into an
// `ApiResult<T>`, normalising the error through `normalizeError` so the UI has
// a single error shape to render.
import { normalizeError, REQUEST_ID_HEADER, type NormalizedError } from "./client";

/** A successful domain call. */
export interface ApiOk<T> {
  ok: true;
  /** Parsed, typed success body. */
  data: T;
  /** Supervisor request id from the response headers, for log correlation. */
  requestId?: string;
}

/** A failed domain call — transport, HTTP error, or client-side validation. */
export interface ApiFail {
  ok: false;
  error: NormalizedError;
}

/** The outcome of a /v0 domain operation: never throws, always one of these. */
export type ApiResult<T> = ApiOk<T> | ApiFail;

/** The subset of an openapi-fetch response that `runApi` consumes. */
export interface RawApiResponse<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

/**
 * Run a typed openapi-fetch call and normalise its outcome into an
 * `ApiResult<T>`. Network/abort rejections (which openapi-fetch propagates) are
 * caught and mapped too, so callers never need their own try/catch.
 *
 * A response with an `error` body, or with no `data`, is treated as a failure —
 * correct for every /v0 endpoint the Cockpit calls (each returns a JSON body on
 * success). Endpoints that legitimately return 204 No Content would need a
 * different helper.
 */
export async function runApi<T>(
  call: () => Promise<RawApiResponse<T>>,
): Promise<ApiResult<T>> {
  let raw: RawApiResponse<T>;
  try {
    raw = await call();
  } catch (thrown) {
    return { ok: false, error: normalizeError(thrown) };
  }

  const { data, error, response } = raw;
  if (error !== undefined || data === undefined) {
    return { ok: false, error: normalizeError(error, response) };
  }
  return {
    ok: true,
    data,
    requestId: response?.headers.get(REQUEST_ID_HEADER) ?? undefined,
  };
}

/**
 * Build a client-side validation failure without touching the network — used to
 * reject obviously-invalid input (e.g. an empty action) before issuing a
 * request the server would 4xx anyway. `status: 0` marks it as never-sent.
 */
export function validationError(detail: string, title = "Invalid request"): ApiFail {
  return { ok: false, error: { status: 0, title, detail } };
}
