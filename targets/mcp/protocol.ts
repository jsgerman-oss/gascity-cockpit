// The MCP / JSON-RPC 2.0 protocol layer for the gascity context server.
//
// MCP's stdio transport is newline-delimited JSON-RPC 2.0. This module owns the
// *protocol* — turning one parsed request object into one response object — and
// nothing else: no stdin/stdout, no sockets, no clock. That keeps `handle`
// pure, so the whole handshake (initialize → tools/list → tools/call) is
// unit-tested by feeding it plain objects (see protocol.test.ts). The stdio loop
// that pumps lines through it lives in ./server.ts; the tools it dispatches to
// live in ./tools.ts.
import { type ToolContext, type ToolDefinition } from "./tools.ts";

/** Server identity advertised in the `initialize` result. */
export interface ServerInfo {
  name: string;
  version: string;
}

/** A JSON-RPC request id: string, number, or null (notifications omit it). */
export type JsonRpcId = string | number | null;

/** A JSON-RPC success response. */
export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

/** A JSON-RPC error response. */
export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// Standard JSON-RPC 2.0 error codes.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** The newest MCP protocol revision this server is written against. */
export const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

export interface DispatcherConfig {
  serverInfo: ServerInfo;
  tools: readonly ToolDefinition[];
  context: ToolContext;
  /** Protocol version offered when a client does not request one. */
  protocolVersion?: string;
}

/** A handler over parsed JSON-RPC messages; returns null for notifications. */
export interface Dispatcher {
  handle(message: unknown): Promise<JsonRpcResponse | null>;
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render a tool's structured result into the MCP `tools/call` content shape. */
function toCallResult(data: unknown, isError: boolean | undefined): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Build a dispatcher bound to a server identity, a tool registry, and a tool
 * context. The returned `handle` maps one parsed JSON-RPC message to a response
 * (or null when the message is a notification that warrants no reply).
 */
export function createDispatcher(config: DispatcherConfig): Dispatcher {
  const offered = config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;

  async function handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isObject(message)) {
      return failure(null, INVALID_REQUEST, "Invalid Request: expected a JSON-RPC object");
    }

    const hasId = "id" in message;
    const rawId = message.id;
    const id: JsonRpcId =
      typeof rawId === "string" || typeof rawId === "number" || rawId === null ? rawId : null;
    const isNotification = !hasId;
    const method = message.method;

    if (typeof method !== "string") {
      return isNotification ? null : failure(id, INVALID_REQUEST, "Invalid Request: missing method");
    }

    // Notifications: acknowledge nothing. `initialized` is the only one clients
    // send us; any other is simply ignored, per JSON-RPC.
    if (isNotification) {
      return null;
    }

    const params = message.params;

    switch (method) {
      case "initialize": {
        const requested = isObject(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
        return success(id, {
          protocolVersion: requested ?? offered,
          capabilities: { tools: {} },
          serverInfo: config.serverInfo,
          instructions:
            "Read-only context over a gascity supervisor's /v0 API: fleet/city status, " +
            "bead queries, merge-queue, telemetry, and recent events. The sling tool " +
            "mutates and is disabled unless the server was started with --allow-writes.",
        });
      }

      case "ping":
        return success(id, {});

      case "tools/list":
        return success(id, {
          tools: config.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case "tools/call":
        return handleToolCall(id, params, config);

      default:
        return failure(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  return { handle };
}

async function handleToolCall(
  id: JsonRpcId,
  params: unknown,
  config: DispatcherConfig,
): Promise<JsonRpcResponse> {
  if (!isObject(params) || typeof params.name !== "string") {
    return failure(id, INVALID_PARAMS, "Invalid params: tools/call requires a string `name`");
  }
  const tool = config.tools.find((t) => t.name === params.name);
  if (!tool) {
    return failure(id, INVALID_PARAMS, `Unknown tool: ${params.name}`);
  }
  const args = isObject(params.arguments) ? params.arguments : {};

  try {
    const result = await tool.handler(config.context, args);
    return success(id, toCallResult(result.data, result.isError));
  } catch (err) {
    // A tool that throws is reported as a tool-level error result (isError), not
    // a protocol error, so the calling model sees what went wrong.
    const text = err instanceof Error ? err.message : String(err);
    return success(id, toCallResult({ error: text }, true));
  }
}
