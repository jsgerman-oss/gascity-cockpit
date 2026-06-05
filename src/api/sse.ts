// Server-Sent Events reader for the supervisor's `text/event-stream` endpoints
// (/v0/events/stream, /v0/city/{c}/session/{id}/stream, …).
//
// openapi-fetch handles request/response endpoints but not SSE, so this is the
// foundation those streaming feature beads build on. `parseSSE` is a pure,
// network-free parser (PRD Seam 1) implementing the WHATWG event-stream parsing
// rules for the fields we use: `event`, `data`, `id`, `retry`. Reconnection and
// backoff are intentionally left to callers (PRD: resilience/reconnect).

/** U+0000; an `id` field containing it is ignored per the SSE spec. */
const NULL_CHAR = String.fromCharCode(0);

/** One dispatched SSE event. `data` is the raw payload (usually JSON to parse). */
export interface SSEMessage {
  /** Event name; defaults to `"message"` when the stream omits an `event:` field. */
  event: string;
  /** Concatenated `data:` field values, joined by newlines, trailing newline stripped. */
  data: string;
  /** Last seen `id:` value; persists across events per the SSE spec. */
  id?: string;
  /** Server-suggested reconnection delay in ms from a `retry:` field, if any. */
  retry?: number;
}

/** Strip the single optional leading space after the field colon, per spec. */
function fieldValue(raw: string): string {
  return raw.startsWith(" ") ? raw.slice(1) : raw;
}

/**
 * Parse a `text/event-stream` body into dispatched {@link SSEMessage}s.
 *
 * Decodes incrementally and tolerates line terminators (`\n`, `\r`, `\r\n`)
 * split across chunk boundaries, so it is safe on arbitrarily-chunked network
 * bodies. An event is dispatched on each blank line, and only when at least one
 * `data:` field was seen for it (matching the WHATWG "empty data buffer" rule).
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEMessage, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");

  let buffer = "";

  // Persist across events, per spec.
  let lastId: string | undefined;
  let retry: number | undefined;

  // Reset on each dispatch.
  let eventType = "";
  let dataLines: string[] = [];
  let sawData = false;

  function dispatch(): SSEMessage | undefined {
    if (!sawData) {
      // No data field → not a dispatchable event; reset the event type only.
      eventType = "";
      return undefined;
    }
    const message: SSEMessage = {
      event: eventType || "message",
      data: dataLines.join("\n"),
      id: lastId,
      retry,
    };
    eventType = "";
    dataLines = [];
    sawData = false;
    return message;
  }

  function processLine(line: string): SSEMessage | undefined {
    if (line === "") {
      return dispatch();
    }
    if (line.startsWith(":")) {
      return undefined; // comment / heartbeat keep-alive
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : fieldValue(line.slice(colon + 1));

    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        dataLines.push(value);
        sawData = true;
        break;
      case "id":
        // Spec: ignore id values containing a NULL character.
        if (!value.includes(NULL_CHAR)) {
          lastId = value;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) {
          retry = Number.parseInt(value, 10);
        }
        break;
      default:
        break; // ignore unknown fields
    }
    return undefined;
  }

  // Extract one complete line from `buffer`. Returns the line (without its
  // terminator) and the buffer remainder, or null when no complete line is
  // available yet. `flush` lets the final read treat a trailing lone `\r` (which
  // could otherwise be the start of a split `\r\n`) as a real terminator.
  function takeLine(flush: boolean): { line: string; rest: string } | null {
    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];
      if (ch === "\n") {
        return { line: buffer.slice(0, i), rest: buffer.slice(i + 1) };
      }
      if (ch === "\r") {
        if (i === buffer.length - 1 && !flush) {
          return null; // could be the "\r" of a split "\r\n"; wait for more
        }
        const skip = buffer[i + 1] === "\n" ? 2 : 1;
        return { line: buffer.slice(0, i), rest: buffer.slice(i + skip) };
      }
    }
    return null;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) {
        buffer += decoder.decode(); // flush any trailing bytes
      }

      for (;;) {
        const taken = takeLine(done);
        if (!taken) {
          break;
        }
        buffer = taken.rest;
        const message = processLine(taken.line);
        if (message) {
          yield message;
        }
      }

      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface OpenSSEOptions {
  /** Fetch implementation; defaults to the global `fetch`. Injectable for tests. */
  fetch?: typeof fetch;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Reconnect cursor, sent as the `Last-Event-ID` header. */
  lastEventId?: string;
  /** Cancels the stream when aborted. */
  signal?: AbortSignal;
  /** Query parameters appended to the URL. */
  query?: Record<string, string | number | boolean | undefined>;
}

/**
 * Open an SSE connection and yield parsed events. This is a single connection:
 * it ends when the server closes the stream or `signal` aborts. Callers that
 * need durability wrap this in a reconnect/backoff loop, threading the last
 * seen {@link SSEMessage.id} back in as {@link OpenSSEOptions.lastEventId}.
 */
export async function* openSSE(
  url: string,
  options: OpenSSEOptions = {},
): AsyncGenerator<SSEMessage, void, unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const target = new URL(url);
  if (options.query) {
    for (const [key, val] of Object.entries(options.query)) {
      if (val !== undefined) {
        target.searchParams.set(key, String(val));
      }
    }
  }

  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    ...options.headers,
  };
  if (options.lastEventId) {
    headers["Last-Event-ID"] = options.lastEventId;
  }

  const response = await fetchImpl(target, { headers, signal: options.signal });
  if (!response.ok) {
    throw new Error(`SSE request failed: HTTP ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error("SSE response has no body");
  }

  yield* parseSSE(response.body);
}
