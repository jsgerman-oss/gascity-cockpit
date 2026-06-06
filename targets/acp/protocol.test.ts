import { describe, it, expect, vi } from "vitest";
import {
  JsonRpcPeer,
  LineBuffer,
  RpcError,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  contentBlocksToText,
  agentMessageChunk,
  type RequestDispatch,
} from "./protocol.ts";

describe("LineBuffer", () => {
  it("splits newline-delimited lines and holds the trailing fragment", () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
    // A partial line is buffered until its newline arrives.
    expect(buf.push('{"c":')).toEqual([]);
    expect(buf.push('3}\n')).toEqual(['{"c":3}']);
  });

  it("tolerates CRLF and skips blank lines", () => {
    const buf = new LineBuffer();
    expect(buf.push("one\r\n\r\ntwo\n")).toEqual(["one", "two"]);
  });

  it("flush returns a non-terminated remainder once", () => {
    const buf = new LineBuffer();
    expect(buf.push("tail-no-newline")).toEqual([]);
    expect(buf.flush()).toBe("tail-no-newline");
    expect(buf.flush()).toBeNull();
  });
});

describe("content helpers", () => {
  it("concatenates only text blocks, ignoring other kinds", () => {
    expect(
      contentBlocksToText([
        { type: "text", text: "Hello " },
        { type: "image", data: "…", mimeType: "image/png" },
        { type: "text", text: "world" },
      ]),
    ).toBe("Hello world");
  });

  it("builds an agent_message_chunk notification", () => {
    expect(agentMessageChunk("sess-1", "hi")).toEqual({
      sessionId: "sess-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    });
  });
});

/** Wire two peers so each one's `send` feeds the other's `receive`. */
function connect(a: { onRequest: RequestDispatch; onNote?: (m: string, p: unknown) => void }, b: { onRequest: RequestDispatch; onNote?: (m: string, p: unknown) => void }) {
  // `peerA`'s send closure captures `peerB` (declared next) — deferred, so safe.
  const peerA: JsonRpcPeer = new JsonRpcPeer({ send: (m) => void peerB.receive(m.trimEnd()), onRequest: a.onRequest, onNotification: a.onNote });
  const peerB: JsonRpcPeer = new JsonRpcPeer({ send: (m) => void peerA.receive(m.trimEnd()), onRequest: b.onRequest, onNotification: b.onNote });
  return { peerA, peerB };
}

describe("JsonRpcPeer", () => {
  it("round-trips a request to a result", async () => {
    const { peerA } = connect(
      { onRequest: async () => ({ never: true }) },
      { onRequest: async (method, params) => ({ method, echoed: params }) },
    );
    const result = await peerA.request("session/new", { cwd: "/tmp" });
    expect(result).toEqual({ method: "session/new", echoed: { cwd: "/tmp" } });
  });

  it("delivers notifications without a response", async () => {
    const onNote = vi.fn();
    const { peerA } = connect({ onRequest: async () => null }, { onRequest: async () => null, onNote });
    peerA.notify("session/cancel", { sessionId: "s1" });
    await Promise.resolve();
    expect(onNote).toHaveBeenCalledWith("session/cancel", { sessionId: "s1" });
  });

  it("propagates a handler RpcError to the caller as a rejection", async () => {
    const { peerA } = connect(
      { onRequest: async () => null },
      {
        onRequest: async () => {
          throw new RpcError(RPC_METHOD_NOT_FOUND, "no such method");
        },
      },
    );
    await expect(peerA.request("bogus")).rejects.toMatchObject({
      code: RPC_METHOD_NOT_FOUND,
      message: "no such method",
    });
  });

  it("wraps a non-RpcError handler throw as an internal error", async () => {
    const { peerA } = connect(
      { onRequest: async () => null },
      {
        onRequest: async () => {
          throw new Error("boom");
        },
      },
    );
    await expect(peerA.request("x")).rejects.toMatchObject({ code: -32603, message: "boom" });
  });

  it("answers a malformed line with a parse error and survives", async () => {
    const sent: string[] = [];
    const peer = new JsonRpcPeer({ send: (m) => sent.push(m), onRequest: async () => null });
    await peer.receive("{not json");
    expect(JSON.parse(sent[0])).toMatchObject({ error: { code: RPC_PARSE_ERROR } });
  });

  it("dispose rejects every in-flight request", async () => {
    // A peer whose send goes nowhere — the request never settles on its own.
    const peer = new JsonRpcPeer({ send: () => {}, onRequest: async () => null });
    const inflight = peer.request("session/prompt");
    peer.dispose(new Error("closed"));
    await expect(inflight).rejects.toThrow("closed");
  });

  it("ignores a response with an unknown id", async () => {
    const peer = new JsonRpcPeer({ send: () => {}, onRequest: async () => null });
    // Should not throw — just a no-op.
    await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }));
  });

  it("ignores a response whose id is null", async () => {
    const peer = new JsonRpcPeer({ send: () => {}, onRequest: async () => null });
    // A null-id response can't correlate to any pending request — dropped in settle().
    await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: null, result: {} }));
  });

  it("routes a notification-handler throw to onError", async () => {
    const errors: unknown[] = [];
    const peer = new JsonRpcPeer({
      send: () => {},
      onRequest: async () => null,
      onNotification: () => {
        throw new Error("note boom");
      },
      onError: (err) => errors.push(err),
    });
    await peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: {} }));
    expect((errors[0] as Error).message).toBe("note boom");
  });

  it("answers a non-object message with an invalid-request error", async () => {
    const sent: string[] = [];
    const peer = new JsonRpcPeer({ send: (m) => sent.push(m), onRequest: async () => null });
    await peer.receive("42"); // valid JSON, but not an object
    expect(JSON.parse(sent[0])).toMatchObject({ id: null, error: { code: RPC_INVALID_REQUEST } });
  });

  it("answers a message with no method with an invalid-request error", async () => {
    const sent: string[] = [];
    const peer = new JsonRpcPeer({ send: (m) => sent.push(m), onRequest: async () => null });
    await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 5 })); // neither a response nor a request
    expect(JSON.parse(sent[0])).toMatchObject({ id: null, error: { code: RPC_INVALID_REQUEST } });
  });
});
