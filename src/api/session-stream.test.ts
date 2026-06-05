import { describe, expect, it } from "vitest";
import {
  awaitSubmitOutcome,
  decodeSessionStreamMessage,
  streamSession,
} from "./session-stream";
import { collect, streamFromChunks } from "../test/helpers";
import type { SSEMessage } from "./sse";

function msg(event: string, data: unknown): SSEMessage {
  return { event, data: typeof data === "string" ? data : JSON.stringify(data) };
}

/** A fetch returning an event-stream body assembled from raw SSE chunks. */
function eventStreamFetch(chunks: string[], capture?: (req: Request) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture(input instanceof Request ? input : new Request(input, init));
    }
    return new Response(streamFromChunks(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

describe("decodeSessionStreamMessage", () => {
  it("decodes a turn event into a conversation snapshot", () => {
    const turns = [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }];
    const decoded = decodeSessionStreamMessage(msg("turn", { format: "conversation", id: "s", provider: "claude", template: "mayor", turns }));
    expect(decoded).toMatchObject({ kind: "turn", turns });
  });

  it("treats a null turns array as empty", () => {
    const decoded = decodeSessionStreamMessage(msg("turn", { format: "conversation", id: "s", provider: "claude", template: "mayor", turns: null }));
    expect(decoded).toMatchObject({ kind: "turn", turns: [] });
  });

  it("decodes activity, pending, and heartbeat events", () => {
    expect(decodeSessionStreamMessage(msg("activity", { activity: "in-turn" }))).toEqual({ kind: "activity", activity: "in-turn" });
    expect(decodeSessionStreamMessage(msg("pending", { kind: "tool-approval", request_id: "p1", prompt: "ok?" }))).toMatchObject({ kind: "pending", pending: { request_id: "p1" } });
    expect(decodeSessionStreamMessage(msg("heartbeat", { timestamp: "2026-06-05T00:00:00Z" }))).toEqual({ kind: "heartbeat", timestamp: "2026-06-05T00:00:00Z" });
  });

  it("falls back to unknown for unrecognised or malformed events", () => {
    expect(decodeSessionStreamMessage(msg("mystery", { a: 1 }))).toMatchObject({ kind: "unknown", event: "mystery" });
    expect(decodeSessionStreamMessage({ event: "turn", data: "{not json" })).toMatchObject({ kind: "unknown", event: "turn" });
    expect(decodeSessionStreamMessage(msg("activity", "{bad")).kind).toBe("activity"); // activity defaults gracefully
  });

  it("defaults a malformed activity payload to 'unknown'", () => {
    expect(decodeSessionStreamMessage({ event: "activity", data: "{bad" })).toEqual({ kind: "activity", activity: "unknown" });
  });
});

describe("streamSession", () => {
  it("opens the per-session stream and yields decoded events", async () => {
    let captured: Request | undefined;
    const fetchImpl = eventStreamFetch(
      ['event: activity\ndata: {"activity":"in-turn"}\n\n', 'event: turn\ndata: {"turns":[{"role":"assistant","text":"hi"}]}\n\n'],
      (req) => { captured = req; },
    );

    const events = await collect(
      streamSession({ baseUrl: "http://api.test", token: "secret" }, { cityName: "c", id: "s" }, { fetch: fetchImpl, format: "conversation" }),
    );

    expect(events.map((e) => e.kind)).toEqual(["activity", "turn"]);
    const url = new URL(captured!.url);
    expect(url.pathname).toBe("/v0/city/c/session/s/stream");
    expect(url.searchParams.get("format")).toBe("conversation");
    expect(captured!.headers.get("authorization")).toBe("Bearer secret");
    expect(captured!.headers.get("accept")).toBe("text/event-stream");
  });

  it("omits the Authorization header when there is no token", async () => {
    let captured: Request | undefined;
    const fetchImpl = eventStreamFetch(["event: heartbeat\ndata: {}\n\n"], (req) => { captured = req; });
    await collect(streamSession({ baseUrl: "http://api.test" }, { cityName: "c", id: "s" }, { fetch: fetchImpl }));
    expect(captured!.headers.get("authorization")).toBeNull();
  });
});

describe("awaitSubmitOutcome", () => {
  const envelope = (type: string, payload: unknown) =>
    `event: event\ndata: ${JSON.stringify({ type, payload, seq: 1, actor: "mayor", ts: "2026-06-05T00:00:00Z" })}\n\n`;

  it("resolves succeeded on a matching request_id and sends after_seq", async () => {
    let captured: Request | undefined;
    const fetchImpl = eventStreamFetch(
      [envelope("session.submit.other", { request_id: "other" }), envelope("request.result.session.submit", { request_id: "r1", session_id: "s" })],
      (req) => { captured = req; },
    );

    const outcome = await awaitSubmitOutcome(
      { baseUrl: "http://api.test" },
      { cityName: "c", requestId: "r1", eventCursor: "100" },
      { fetch: fetchImpl },
    );

    expect(outcome).toEqual({ kind: "succeeded", type: "request.result.session.submit" });
    const url = new URL(captured!.url);
    expect(url.pathname).toBe("/v0/city/c/events/stream");
    expect(url.searchParams.get("after_seq")).toBe("100");
  });

  it("resolves failed on a matching request.failed envelope", async () => {
    const fetchImpl = eventStreamFetch([
      envelope("request.failed", { request_id: "r1", operation: "session.submit", error_code: "busy", error_message: "session is busy" }),
    ]);
    const outcome = await awaitSubmitOutcome({ baseUrl: "http://api.test" }, { cityName: "c", requestId: "r1" }, { fetch: fetchImpl });
    expect(outcome).toEqual({ kind: "failed", errorCode: "busy", errorMessage: "session is busy", operation: "session.submit" });
  });

  it("resolves stream-ended when no envelope matches before the stream closes", async () => {
    const fetchImpl = eventStreamFetch([envelope("request.failed", { request_id: "someone-else", error_code: "x", error_message: "y" })]);
    const outcome = await awaitSubmitOutcome({ baseUrl: "http://api.test" }, { cityName: "c", requestId: "r1" }, { fetch: fetchImpl });
    expect(outcome).toEqual({ kind: "stream-ended" });
  });
});
