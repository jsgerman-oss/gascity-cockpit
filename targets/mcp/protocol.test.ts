// Tests for the MCP / JSON-RPC dispatcher: the initialize handshake, tools/list,
// tools/call, and the error mapping — driven with plain message objects (no
// stdio). The end-to-end case here is the cockpit-dc8.6 gate: the server lists
// its tools and answers a fleet-status call against a stub /v0.
import { describe, expect, it } from "vitest";
import * as core from "../../src/core/index.ts";
import { mockFetch, jsonResponse, problemResponse } from "../../src/test/helpers.ts";
import { TOOLS, type ToolContext, type ToolDefinition } from "./tools.ts";
import {
  createDispatcher,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  type Dispatcher,
  type JsonRpcError,
  type JsonRpcSuccess,
} from "./protocol.ts";

/** A dispatcher wired to a stub /v0 that knows cities + agents. */
function stubDispatcher(allowWrites = false): { dispatcher: Dispatcher; calls: Request[] } {
  const { fetch, calls } = mockFetch((req) => {
    const p = new URL(req.url).pathname;
    if (p === "/v0/cities") return jsonResponse({ items: [{ name: "hq", path: "/a", running: true, status: "running" }] });
    if (p === "/v0/city/hq/agents") return jsonResponse({ items: [{ name: "mayor", state: "running", running: true, active_bead: "cockpit-dc8" }] });
    return problemResponse({ title: "not found" }, { status: 404 });
  });
  const client = core.api.createCockpitClient({ baseUrl: "http://stub", fetch });
  const repo = new core.beads.BeadsRepository({ getClient: () => client });
  const context: ToolContext = { endpoint: "http://stub", client, repo, allowWrites };
  const dispatcher = createDispatcher({
    serverInfo: { name: "gascity", version: "0.0.0-test" },
    tools: TOOLS,
    context,
  });
  return { dispatcher, calls };
}

function asSuccess(response: unknown): JsonRpcSuccess {
  const r = response as JsonRpcSuccess;
  expect(r.jsonrpc).toBe("2.0");
  expect("result" in r).toBe(true);
  return r;
}

function asError(response: unknown): JsonRpcError {
  const r = response as JsonRpcError;
  expect(r.jsonrpc).toBe("2.0");
  expect("error" in r).toBe(true);
  return r;
}

describe("initialize handshake", () => {
  it("returns server info, tools capability, and echoes the client's protocol version", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asSuccess(
      await dispatcher.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    );
    const result = res.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo).toMatchObject({ name: "gascity" });
    expect((result.capabilities as Record<string, unknown>).tools).toBeDefined();
  });

  it("falls back to the default protocol version when the client omits one", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asSuccess(await dispatcher.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect((res.result as Record<string, unknown>).protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("falls back to the default protocol version when params are absent entirely", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asSuccess(await dispatcher.handle({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    expect((res.result as Record<string, unknown>).protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("treats the initialized notification as no-reply", async () => {
    const { dispatcher } = stubDispatcher();
    expect(await dispatcher.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("answers ping with an empty result", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asSuccess(await dispatcher.handle({ jsonrpc: "2.0", id: 9, method: "ping" }));
    expect(res.result).toEqual({});
  });
});

describe("tools/list", () => {
  it("lists every registered tool with name, description, and schema", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asSuccess(await dispatcher.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const tools = (res.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((t) => t.name)).toContain("fleet_status");
    expect(tools).toHaveLength(TOOLS.length);
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect((t.inputSchema as { type: string }).type).toBe("object");
    }
  });
});

describe("tools/call — the gate: answer fleet_status against a stub /v0", () => {
  it("returns a text content block whose JSON carries the fleet", async () => {
    const { dispatcher, calls } = stubDispatcher();
    const res = asSuccess(
      await dispatcher.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fleet_status", arguments: {} } }),
    );
    const result = res.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text) as { endpoint: string; cities: Array<{ name: string; agents: unknown[] }> };
    expect(parsed.endpoint).toBe("http://stub");
    expect(parsed.cities[0].name).toBe("hq");
    expect(parsed.cities[0].agents).toHaveLength(1);
    // The handler actually hit the stub /v0.
    expect(calls.some((c) => new URL(c.url).pathname === "/v0/cities")).toBe(true);
  });

  it("works without an arguments object", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asSuccess(
      await dispatcher.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fleet_status" } }),
    );
    expect((res.result as { content: unknown[] }).content).toBeDefined();
  });

  it("marks a tool-level failure with isError but still returns a result", async () => {
    const { dispatcher } = stubDispatcher(false);
    const res = asSuccess(
      await dispatcher.handle({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "sling_bead", arguments: { city: "hq", target: "hq/x" } },
      }),
    );
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("writes disabled");
  });
});

describe("error mapping", () => {
  it("rejects an unknown method with method-not-found", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asError(await dispatcher.handle({ jsonrpc: "2.0", id: 6, method: "resources/list" }));
    expect(res.error.code).toBe(METHOD_NOT_FOUND);
  });

  it("rejects an unknown tool with invalid-params", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asError(
      await dispatcher.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } }),
    );
    expect(res.error.code).toBe(INVALID_PARAMS);
    expect(res.error.message).toContain("Unknown tool");
  });

  it("rejects tools/call without a name", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asError(await dispatcher.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} }));
    expect(res.error.code).toBe(INVALID_PARAMS);
  });

  it("rejects a non-object message", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asError(await dispatcher.handle(42));
    expect(res.error.code).toBe(INVALID_REQUEST);
    expect(res.id).toBeNull();
  });

  it("ignores an unknown notification (no id) silently", async () => {
    const { dispatcher } = stubDispatcher();
    expect(await dispatcher.handle({ jsonrpc: "2.0", method: "notifications/cancelled" })).toBeNull();
  });

  it("rejects a request whose method is not a string", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asError(await dispatcher.handle({ jsonrpc: "2.0", id: 1, method: 42 }));
    expect(res.error.code).toBe(INVALID_REQUEST);
    expect(res.error.message).toContain("missing method");
  });

  it("ignores a notification whose method is not a string", async () => {
    const { dispatcher } = stubDispatcher();
    expect(await dispatcher.handle({ jsonrpc: "2.0", method: 42 })).toBeNull();
  });

  it("coerces a non-scalar id to null in the response", async () => {
    const { dispatcher } = stubDispatcher();
    const res = asSuccess(await dispatcher.handle({ jsonrpc: "2.0", id: { weird: true }, method: "ping" }));
    expect(res.id).toBeNull();
  });

  it("maps a throwing tool handler to an isError result, not a protocol error", async () => {
    const throwing: ToolDefinition = {
      name: "boom",
      description: "always throws, to exercise the catch path",
      inputSchema: { type: "object" },
      handler: async () => {
        throw new Error("kaboom");
      },
    };
    const dispatcher = createDispatcher({ serverInfo: { name: "t", version: "0" }, tools: [throwing], context: {} as never });
    const res = asSuccess(
      await dispatcher.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom" } }),
    );
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("kaboom");
  });
});
