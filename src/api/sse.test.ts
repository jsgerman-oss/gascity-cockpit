import { describe, expect, it } from "vitest";
import { parseSSE, openSSE } from "./sse";
import { collect, streamFromChunks } from "../test/helpers";

async function parse(chunks: Array<string | Uint8Array>) {
  return collect(parseSSE(streamFromChunks(chunks)));
}

describe("parseSSE", () => {
  it("parses a single event with an explicit name", async () => {
    const events = await parse(["event: ping\ndata: hello\n\n"]);
    expect(events).toEqual([{ event: "ping", data: "hello", id: undefined, retry: undefined }]);
  });

  it("defaults the event name to 'message'", async () => {
    const events = await parse(["data: hi\n\n"]);
    expect(events[0].event).toBe("message");
  });

  it("joins multiple data lines with newlines", async () => {
    const events = await parse(["data: line1\ndata: line2\n\n"]);
    expect(events[0].data).toBe("line1\nline2");
  });

  it("dispatches an empty-string data event for a bare 'data:' field", async () => {
    const events = await parse(["data:\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("");
  });

  it("does not dispatch when an event has no data field", async () => {
    const events = await parse([": just a comment\n\n", "event: noop\n\n"]);
    expect(events).toEqual([]);
  });

  it("ignores comment lines", async () => {
    const events = await parse([": keep-alive\ndata: real\n\n"]);
    expect(events).toEqual([{ event: "message", data: "real", id: undefined, retry: undefined }]);
  });

  it("persists the last id across subsequent events", async () => {
    const events = await parse(["id: 42\ndata: a\n\ndata: b\n\n"]);
    expect(events.map((e) => [e.id, e.data])).toEqual([
      ["42", "a"],
      ["42", "b"],
    ]);
  });

  it("parses the retry field", async () => {
    const events = await parse(["retry: 3000\ndata: a\n\n"]);
    expect(events[0].retry).toBe(3000);
  });

  it("handles a field line with no colon as an empty value", async () => {
    const events = await parse(["data\ndata: x\n\n"]);
    expect(events[0].data).toBe("\nx");
  });

  it("handles CRLF line terminators", async () => {
    const events = await parse(["event: x\r\ndata: y\r\n\r\n"]);
    expect(events).toEqual([{ event: "x", data: "y", id: undefined, retry: undefined }]);
  });

  it("handles a lone CR line terminator", async () => {
    const events = await parse(["data: y\r\r"]);
    expect(events[0].data).toBe("y");
  });

  it("reassembles an event split across chunks", async () => {
    const events = await parse(["eve", "nt: pi", "ng\nda", "ta: hi\n", "\n"]);
    expect(events).toEqual([{ event: "ping", data: "hi", id: undefined, retry: undefined }]);
  });

  it("handles a CRLF split across the chunk boundary", async () => {
    const events = await parse(["data: a\r", "\n\r\n"]);
    expect(events).toEqual([{ event: "message", data: "a", id: undefined, retry: undefined }]);
  });

  it("decodes multi-byte UTF-8 split across chunks", async () => {
    const full = new TextEncoder().encode("data: café\n\n");
    const splitAt = full.indexOf(0xc3) + 1; // between the two bytes of 'é'
    const events = await parse([full.slice(0, splitAt), full.slice(splitAt)]);
    expect(events[0].data).toBe("café");
  });

  it("parses several events from one chunk", async () => {
    const events = await parse(["data: one\n\ndata: two\n\ndata: three\n\n"]);
    expect(events.map((e) => e.data)).toEqual(["one", "two", "three"]);
  });

  it("parses a realistic heartbeat event with JSON payload", async () => {
    const payload = JSON.stringify({ now: "2026-06-04T00:00:00Z" });
    const events = await parse([`event: heartbeat\ndata: ${payload}\nid: 0:5:1\n\n`]);
    expect(events[0].event).toBe("heartbeat");
    expect(events[0].id).toBe("0:5:1");
    expect(JSON.parse(events[0].data)).toEqual({ now: "2026-06-04T00:00:00Z" });
  });
});

describe("openSSE", () => {
  it("sets streaming headers and yields parsed events", async () => {
    let captured: Request | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = input instanceof Request ? input : new Request(input, init);
      return new Response(streamFromChunks(["data: hi\n\n"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const events = await collect(
      openSSE("http://api.test/v0/events/stream", {
        fetch: fetchImpl,
        lastEventId: "cursor-9",
        query: { after_cursor: "c1" },
      }),
    );

    expect(events).toEqual([{ event: "message", data: "hi", id: undefined, retry: undefined }]);
    expect(captured?.headers.get("accept")).toBe("text/event-stream");
    expect(captured?.headers.get("last-event-id")).toBe("cursor-9");
    expect(new URL(captured!.url).searchParams.get("after_cursor")).toBe("c1");
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as typeof fetch;
    await expect(collect(openSSE("http://api.test/v0/events/stream", { fetch: fetchImpl }))).rejects.toThrow(
      /HTTP 503/,
    );
  });
});
