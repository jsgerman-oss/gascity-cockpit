// Session / chat API methods over the typed /v0 client.
//
// This is the chat-with-Mayor request surface: read the transcript, submit to
// the live loop (with an intent), send a side-conversation message, and look up
// session detail / the session list for the chat target picker (PRD Stories
// 16–22). The pending / respond / permission-mode half lives in `./approvals`,
// and streaming in `./session-stream`; this module deliberately does not
// duplicate them.
//
// Like the rest of `./api` it is provider-agnostic (no `vscode` import) and
// unit-tested against an OpenAPI-conformant mock /v0 server (PRD Testing
// Decisions, Seam 1). It reuses the shared `runApi` result wrapper and the
// `csrfHeader` mutation header so its shape matches the other domain layers.
import type { CockpitClient } from "./client";
import { csrfHeader } from "./client";
import { runApi, type ApiResult } from "./result";
import type { Schema, SessionDetail } from "./types";

// Chat-specific domain aliases. (Shared shapes — SessionDetail, PendingInteraction,
// CityPendingEntry, SessionRespondResult — already live in `./types`.)

/** Paginated envelope of {@link SessionDetail} from `GET /sessions`. */
export type SessionList = Schema<"ListBodySessionResponse">;
/** `GET /session/{id}/transcript` body — `turns` for conversation/text formats. */
export type SessionTranscript = Schema<"SessionTranscriptGetResponse">;
/** One conversation turn: `{ role, text, timestamp? }`. */
export type ConversationTurn = Schema<"OutputTurn">;
/** Submit intent enum: `"default" | "follow_up" | "interrupt_now"`. */
export type SubmitIntent = Schema<"SubmitIntent">;
/** `202 Accepted` body carrying the `request_id` + `event_cursor` correlation pair. */
export type AsyncAccepted = Schema<"AsyncAcceptedBody">;
/** Whether a session's provider supports follow-up / interrupt-now submits. */
export type SubmissionCapabilities = Schema<"SubmissionCapabilities">;

/** Identifies a single session within a city. */
export interface SessionRef {
  /** City name (supervisor mode serves many cities under `/v0/city/{name}`). */
  cityName: string;
  /** Session ID, alias, or runtime session_name. */
  id: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface GetTranscriptParams extends SessionRef {
  /** `"conversation"` (default) or `"raw"`. */
  format?: string;
  /** Recent compaction segments to return; `"0"` = all, omit for the default. */
  tail?: string;
  /** Pagination cursor — entries before this UUID. */
  before?: string;
  /** Pagination cursor — entries after this UUID. */
  after?: string;
}

/** `GET /session/{id}/transcript` — the structured conversation (PRD Story 18). */
export function getSessionTranscript(
  client: CockpitClient,
  params: GetTranscriptParams,
): Promise<ApiResult<SessionTranscript>> {
  return runApi(() =>
    client.GET("/v0/city/{cityName}/session/{id}/transcript", {
      params: {
        path: { cityName: params.cityName, id: params.id },
        query: {
          ...(params.format !== undefined ? { format: params.format } : {}),
          ...(params.tail !== undefined ? { tail: params.tail } : {}),
          ...(params.before !== undefined ? { before: params.before } : {}),
          ...(params.after !== undefined ? { after: params.after } : {}),
        },
      },
    }),
  );
}

export interface GetSessionParams extends SessionRef {
  /** Include a preview of the last output. */
  peek?: boolean;
  /** Lines of preview when `peek` is set. */
  peekLines?: number;
}

/** `GET /session/{id}` — full session detail, incl. submission capabilities. */
export function getSession(
  client: CockpitClient,
  params: GetSessionParams,
): Promise<ApiResult<SessionDetail>> {
  return runApi(() =>
    client.GET("/v0/city/{cityName}/session/{id}", {
      params: {
        path: { cityName: params.cityName, id: params.id },
        query: {
          ...(params.peek !== undefined ? { peek: params.peek } : {}),
          ...(params.peekLines !== undefined ? { peek_lines: params.peekLines } : {}),
        },
      },
    }),
  );
}

export interface ListSessionsParams {
  cityName: string;
  cursor?: string;
  limit?: number;
  /** Filter by session state, e.g. `"active"`. */
  state?: string;
  /** Filter by template (agent qualified name). */
  template?: string;
  /** Include last-output preview per session. */
  peek?: boolean;
}

/** `GET /sessions` — list sessions in a city (for the chat target picker). */
export function listSessions(
  client: CockpitClient,
  params: ListSessionsParams,
): Promise<ApiResult<SessionList>> {
  return runApi(() =>
    client.GET("/v0/city/{cityName}/sessions", {
      params: {
        path: { cityName: params.cityName },
        query: {
          ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.state !== undefined ? { state: params.state } : {}),
          ...(params.template !== undefined ? { template: params.template } : {}),
          ...(params.peek !== undefined ? { peek: params.peek } : {}),
        },
      },
    }),
  );
}

/** Read the current permission mode out of a session's `options` map, if present. */
export function permissionModeOf(session: SessionDetail): string | null {
  return session.options?.permission_mode ?? null;
}

// ---------------------------------------------------------------------------
// Submits (mutations — carry the anti-CSRF header via csrfHeader())
// ---------------------------------------------------------------------------

export interface SubmitParams extends SessionRef {
  /** Message text to submit (must be non-empty). */
  message: string;
  /** Submit intent; defaults to `"default"` server-side when omitted. */
  intent?: SubmitIntent;
}

/**
 * `POST /session/{id}/submit` — submit to the live autonomous loop with an
 * intent (`default` / `follow_up` / `interrupt_now`; PRD Stories 16, 20, 21).
 * Returns `{ request_id, event_cursor }` for stream correlation.
 */
export function submitToSession(
  client: CockpitClient,
  params: SubmitParams,
): Promise<ApiResult<AsyncAccepted>> {
  return runApi(() =>
    client.POST("/v0/city/{cityName}/session/{id}/submit", {
      params: { path: { cityName: params.cityName, id: params.id }, header: csrfHeader() },
      body: {
        message: params.message,
        ...(params.intent !== undefined ? { intent: params.intent } : {}),
      },
    }),
  );
}

export interface SendMessageParams extends SessionRef {
  message: string;
}

/**
 * `POST /session/{id}/messages` — send a message without an intent. Used for the
 * throwaway "Ask" side-conversation (PRD Story 22) that does not steer intent.
 */
export function sendSessionMessage(
  client: CockpitClient,
  params: SendMessageParams,
): Promise<ApiResult<AsyncAccepted>> {
  return runApi(() =>
    client.POST("/v0/city/{cityName}/session/{id}/messages", {
      params: { path: { cityName: params.cityName, id: params.id }, header: csrfHeader() },
      body: { message: params.message },
    }),
  );
}
