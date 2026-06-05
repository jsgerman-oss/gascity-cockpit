// Typed streaming for the chat surface, built on the network-free SSE reader in
// `./sse`. Two streams matter for chat (PRD Implementation Decisions):
//
//  1. The per-session stream `/session/{id}/stream` — the live conversation:
//     `turn` (full transcript snapshot), `activity` (idle / in-turn), `pending`
//     (a tool-approval / prompt-for-input awaiting a human), `heartbeat`.
//  2. The city event stream `/events/stream` — used to correlate a `submit` /
//     `messages` call's `request_id` (from its 202 `AsyncAccepted`) to a
//     terminal `succeeded` / `failed` outcome, replaying only from `event_cursor`.
//
// Like the rest of `./api` this is provider-agnostic and unit-tested against
// mock event-stream bodies (PRD Testing Decisions, Seam 1).
import { openSSE, type SSEMessage } from "./sse";
import type { PendingInteraction, Schema } from "./types";
import type { ConversationTurn, SessionRef } from "./sessions";

/** A resolved API endpoint the streams connect to. */
export interface StreamEndpoint {
  /** Base URL with no trailing slash, e.g. "http://127.0.0.1:8372". */
  baseUrl: string;
  /** Bearer token, or null/undefined when unauthenticated. */
  token?: string | null;
}

/** `turn` SSE payload — a conversation snapshot. */
export type SessionTurnEvent = Schema<"SessionStreamMessageEvent">;
/** `message` SSE payload — provider-native raw frames. */
export type SessionRawEvent = Schema<"SessionStreamRawMessageEvent">;
/** City event-stream envelope (`{ type, payload, seq, ts, ... }`). */
export type EventEnvelope = Schema<"EventStreamEnvelope">;

/**
 * One decoded per-session stream event. A discriminated union keyed on `kind`
 * so the conversation store can `switch` without re-parsing JSON or sniffing the
 * SSE `event` field.
 */
export type SessionStreamEvent =
  | { kind: "turn"; turns: ConversationTurn[]; event: SessionTurnEvent }
  | { kind: "raw"; event: SessionRawEvent }
  | { kind: "activity"; activity: string }
  | { kind: "pending"; pending: PendingInteraction }
  | { kind: "heartbeat"; timestamp: string }
  | { kind: "unknown"; event: string; data: unknown };

function authHeaders(token?: string | null): Record<string, string> | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/** Parse JSON, returning `undefined` instead of throwing on malformed data. */
function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Decode one raw {@link SSEMessage} from the per-session stream into a typed
 * {@link SessionStreamEvent}. Pure and network-free — the seam the stream tests
 * exercise directly. Malformed or unrecognised messages become `unknown` rather
 * than throwing, so a single bad frame never tears down the stream.
 */
export function decodeSessionStreamMessage(message: SSEMessage): SessionStreamEvent {
  switch (message.event) {
    case "turn": {
      const event = parseJson<SessionTurnEvent>(message.data);
      if (!event) {
        return { kind: "unknown", event: message.event, data: message.data };
      }
      return { kind: "turn", turns: event.turns ?? [], event };
    }
    case "message": {
      const event = parseJson<SessionRawEvent>(message.data);
      if (!event) {
        return { kind: "unknown", event: message.event, data: message.data };
      }
      return { kind: "raw", event };
    }
    case "activity": {
      const event = parseJson<{ activity?: string }>(message.data);
      return { kind: "activity", activity: event?.activity ?? "unknown" };
    }
    case "pending": {
      const pending = parseJson<PendingInteraction>(message.data);
      if (!pending) {
        return { kind: "unknown", event: message.event, data: message.data };
      }
      return { kind: "pending", pending };
    }
    case "heartbeat": {
      const event = parseJson<{ timestamp?: string }>(message.data);
      return { kind: "heartbeat", timestamp: event?.timestamp ?? "" };
    }
    default:
      return { kind: "unknown", event: message.event, data: parseJson(message.data) ?? message.data };
  }
}

export interface StreamSessionOptions {
  /** Fetch implementation; defaults to the global `fetch`. Injectable for tests. */
  fetch?: typeof fetch;
  /** Aborts the stream when fired (e.g. panel disposed / session switched). */
  signal?: AbortSignal;
  /** Transcript format: `"conversation"` (default) or `"raw"`. */
  format?: string;
  /** Resume cursor sent as `Last-Event-ID`. */
  lastEventId?: string;
}

/**
 * Open the per-session SSE stream and yield decoded {@link SessionStreamEvent}s.
 * One connection: it ends when the server closes the stream or `signal` aborts.
 * Reconnect/backoff is the caller's concern (the conversation store), threading
 * the last seen event id back via {@link StreamSessionOptions.lastEventId}.
 */
export async function* streamSession(
  endpoint: StreamEndpoint,
  params: SessionRef,
  options: StreamSessionOptions = {},
): AsyncGenerator<SessionStreamEvent, void, unknown> {
  const url =
    `${endpoint.baseUrl}/v0/city/${encodeURIComponent(params.cityName)}` +
    `/session/${encodeURIComponent(params.id)}/stream`;
  for await (const message of openSSE(url, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(authHeaders(endpoint.token) ? { headers: authHeaders(endpoint.token) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.lastEventId ? { lastEventId: options.lastEventId } : {}),
    ...(options.format ? { query: { format: options.format } } : {}),
  })) {
    yield decodeSessionStreamMessage(message);
  }
}

/** Terminal outcome of a correlated `submit` / `messages` request. */
export type SubmitOutcome =
  | { kind: "succeeded"; type: string }
  | { kind: "failed"; errorCode: string; errorMessage: string; operation?: string }
  | { kind: "stream-ended" };

/** The envelope-payload fields we read for correlation (a thin view over the union). */
interface CorrelatablePayload {
  request_id?: string;
  error_code?: string;
  error_message?: string;
  operation?: string;
}

export interface AwaitSubmitOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface AwaitSubmitParams {
  cityName: string;
  /** Correlation id from the submit's 202 `AsyncAccepted.request_id`. */
  requestId: string;
  /** `AsyncAccepted.event_cursor`; replays the city stream from just before submit. */
  eventCursor?: string;
}

/**
 * Watch the city event stream for the terminal outcome of a submitted request,
 * replaying only from `event_cursor` so no backlog is re-processed (PRD: async
 * request correlation). Resolves on the first envelope whose `payload.request_id`
 * matches: a `*.failed` type (or a payload carrying `error_code`) is a failure,
 * anything else carrying our id is success. Resolves `stream-ended` if the
 * stream closes (or aborts) before a match — the caller decides how to treat it.
 */
export async function awaitSubmitOutcome(
  endpoint: StreamEndpoint,
  params: AwaitSubmitParams,
  options: AwaitSubmitOptions = {},
): Promise<SubmitOutcome> {
  const url = `${endpoint.baseUrl}/v0/city/${encodeURIComponent(params.cityName)}/events/stream`;
  const stream = openSSE(url, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(authHeaders(endpoint.token) ? { headers: authHeaders(endpoint.token) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(params.eventCursor ? { query: { after_seq: params.eventCursor } } : {}),
  });

  for await (const message of stream) {
    // City envelopes arrive as `event: event`; skip heartbeats/comments.
    if (message.event !== "event") {
      continue;
    }
    const envelope = parseJson<EventEnvelope>(message.data);
    if (!envelope) {
      continue;
    }
    // `payload` is the broad EventPayload union; we only read correlation fields.
    const payload = envelope.payload as unknown as CorrelatablePayload | undefined;
    if (!payload || payload.request_id !== params.requestId) {
      continue;
    }
    if (/fail/i.test(envelope.type) || payload.error_code) {
      return {
        kind: "failed",
        errorCode: payload.error_code ?? "unknown",
        errorMessage: payload.error_message ?? envelope.message ?? "Request failed",
        ...(payload.operation ? { operation: payload.operation } : {}),
      };
    }
    return { kind: "succeeded", type: envelope.type };
  }

  return { kind: "stream-ended" };
}
