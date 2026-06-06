// The Agent Client Protocol (ACP) wire layer for the `acp-mayor` adapter.
//
// ACP (https://agentclientprotocol.com) is how Zed — and the JetBrains / VS Code
// ACP extensions — talk to an external agent: JSON-RPC 2.0 over stdio, framed as
// newline-delimited JSON (one message per line). The client (the editor) drives
// `initialize` → `session/new` → `session/prompt`; the agent answers and, mid
// turn, streams `session/update` notifications and asks for tool permission via
// `session/request_permission`.
//
// This module is the transport + type layer only — pure, `vscode`-free, and
// Node-built-in-free so it unit-tests against in-memory transports. The actual
// /v0 mapping lives in ./bridge; the stdio wiring lives in ./acp-mayor.
//
// References for the shapes below: ACP "Initialization", "Prompt Turn", and
// "Tool Calls / Requesting Permission" schema sections (protocol version 1).

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

/** Reserved JSON-RPC id type — a request correlation handle. */
export type RpcId = number | string;

/** An outbound/inbound JSON-RPC request (has `id`, expects a response). */
export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown;
}

/** A JSON-RPC notification (no `id`, no response). */
export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** A JSON-RPC success/error response. */
export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId | null;
  result?: unknown;
  error?: RpcErrorBody;
}

/** The `error` member of a JSON-RPC response. */
export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** Standard JSON-RPC 2.0 error codes (plus ACP's `auth_required`). */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;
/** ACP: the request needs `authenticate` first. */
export const RPC_AUTH_REQUIRED = -32000;

/** A typed error a request handler can throw to control the JSON-RPC error body. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }

  toBody(): RpcErrorBody {
    return { code: this.code, message: this.message, ...(this.data !== undefined ? { data: this.data } : {}) };
  }
}

// ---------------------------------------------------------------------------
// ACP method names + protocol constants
// ---------------------------------------------------------------------------

export const ACP_PROTOCOL_VERSION = 1;

export const METHOD_INITIALIZE = "initialize";
export const METHOD_AUTHENTICATE = "authenticate";
export const METHOD_SESSION_NEW = "session/new";
export const METHOD_SESSION_LOAD = "session/load";
export const METHOD_SESSION_PROMPT = "session/prompt";
export const METHOD_SESSION_CANCEL = "session/cancel";
export const METHOD_SESSION_UPDATE = "session/update";
export const METHOD_SESSION_REQUEST_PERMISSION = "session/request_permission";

// ---------------------------------------------------------------------------
// ACP content + session shapes (the subset the Mayor chat slice needs)
// ---------------------------------------------------------------------------

/** A text content block — the only kind the Mayor chat produces or consumes. */
export interface TextContentBlock {
  type: "text";
  text: string;
}

/**
 * An ACP content block. The Mayor chat is text; non-text blocks (image, audio,
 * resource, resource_link) are accepted on input and ignored, never produced.
 */
export type ContentBlock = TextContentBlock | { type: string; [key: string]: unknown };

/** `initialize` params from the client. */
export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
}

/** `initialize` result the agent returns. */
export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    /** We do not persist/resume sessions, so `session/load` is unsupported. */
    loadSession: boolean;
    promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
  };
  /** No auth: the supervisor endpoint/token are adapter config, not per-prompt. */
  authMethods: AuthMethod[];
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

/** `session/new` params. `cwd`/`mcpServers` are accepted but unused by the bridge. */
export interface NewSessionParams {
  cwd?: string;
  mcpServers?: unknown[];
}

/** `session/new` result — the ACP session id the client uses for prompts. */
export interface NewSessionResult {
  sessionId: string;
}

/** `session/prompt` params: a session id and the user's content blocks. */
export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

/** Why a prompt turn ended (ACP `StopReason`). */
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** `session/prompt` result. */
export interface PromptResult {
  stopReason: StopReason;
}

/** `session/cancel` params (a notification). */
export interface CancelParams {
  sessionId: string;
}

/**
 * One `session/update` payload. A discriminated union keyed on `sessionUpdate`;
 * the Mayor adapter emits `agent_message_chunk` (assistant text) and
 * `agent_thought_chunk` is reserved for future provider reasoning streams.
 */
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock };

/** `session/update` notification params. */
export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

/** A permission choice offered to the client for a tool-approval. */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** A minimal tool-call descriptor for `session/request_permission`. */
export interface ToolCallUpdate {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string;
}

/** `session/request_permission` params (agent → client). */
export interface RequestPermissionParams {
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

/** `session/request_permission` result the client returns. */
export interface RequestPermissionResult {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}

// ---------------------------------------------------------------------------
// Line framing: ndjson over a byte/string stream
// ---------------------------------------------------------------------------

/**
 * Buffers stream chunks and splits them into newline-delimited messages. ACP
 * frames each JSON-RPC message as one line; a chunk may carry a partial line or
 * several, so the trailing fragment is held until its newline arrives.
 */
export class LineBuffer {
  private buffer = "";

  /** Push a chunk; return every complete (newline-terminated) line it yields. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      // Tolerate CRLF as well as LF.
      const raw = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (raw.length > 0) {
        lines.push(raw);
      }
      index = this.buffer.indexOf("\n");
    }
    return lines;
  }

  /** Any buffered, not-yet-terminated remainder (e.g. a final line at EOF). */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest.length > 0 ? rest : null;
  }
}

// ---------------------------------------------------------------------------
// The JSON-RPC peer — bidirectional, transport-agnostic
// ---------------------------------------------------------------------------

/** Dispatches an inbound request to a result (or throws {@link RpcError}). */
export type RequestDispatch = (method: string, params: unknown) => Promise<unknown>;
/** Handles an inbound notification (no response). */
export type NotificationDispatch = (method: string, params: unknown) => void | Promise<void>;

export interface PeerOptions {
  /** Write one already-serialized message line (the `\n` is added by the peer). */
  send: (message: string) => void;
  /** Handle inbound requests (those carrying an `id`). */
  onRequest: RequestDispatch;
  /** Handle inbound notifications (those without an `id`). Optional. */
  onNotification?: NotificationDispatch;
  /** Reports a handler/transport error that could not be returned to a caller. */
  onError?: (error: unknown) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * A minimal, dependency-free JSON-RPC 2.0 peer that is symmetric: it answers
 * inbound requests/notifications via the injected dispatchers and issues its own
 * outbound {@link request}/{@link notify}, correlating responses by id. It owns
 * neither the socket nor the line framing — feed it complete lines via
 * {@link receive} and give it a `send` that writes a line. That keeps it pure
 * and exhaustively testable with two in-memory peers wired to each other.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();

  constructor(private readonly options: PeerOptions) {}

  /** Issue an outbound request and resolve with its result (or reject on error). */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  /** Issue an outbound notification (fire-and-forget). */
  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  /**
   * Feed one inbound line. Routes it as a response (resolves a pending request),
   * a request (dispatches and replies), or a notification (dispatches). A
   * malformed line yields a parse-error response; a handler throw becomes a
   * JSON-RPC error response so one bad turn never tears down the connection.
   */
  async receive(line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.write({ jsonrpc: "2.0", id: null, error: { code: RPC_PARSE_ERROR, message: "Parse error" } });
      return;
    }
    if (!isObject(message)) {
      this.write({ jsonrpc: "2.0", id: null, error: { code: RPC_INVALID_REQUEST, message: "Invalid request" } });
      return;
    }

    // A response correlates to one of our outbound requests.
    if (("result" in message || "error" in message) && "id" in message) {
      this.settle(message as unknown as RpcResponse);
      return;
    }

    // Otherwise it is an inbound request or notification.
    const method = message.method;
    if (typeof method !== "string") {
      this.write({ jsonrpc: "2.0", id: null, error: { code: RPC_INVALID_REQUEST, message: "Invalid request" } });
      return;
    }
    const params = message.params;

    if ("id" in message && message.id !== undefined && message.id !== null) {
      const id = message.id as RpcId;
      try {
        const result = await this.options.onRequest(method, params);
        this.write({ jsonrpc: "2.0", id, result: result ?? null });
      } catch (error) {
        this.write({ jsonrpc: "2.0", id, error: toErrorBody(error) });
      }
      return;
    }

    // A notification — no reply, ever.
    try {
      await this.options.onNotification?.(method, params);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /** Reject every still-pending outbound request (e.g. the stream closed). */
  dispose(reason?: unknown): void {
    const err = reason ?? new Error("connection closed");
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  private settle(response: RpcResponse): void {
    const id = response.id;
    if (id === null) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return; // Unknown id — a duplicate or already-timed-out response.
    }
    this.pending.delete(id);
    if (response.error) {
      pending.reject(new RpcError(response.error.code, response.error.message, response.error.data));
    } else {
      pending.resolve(response.result);
    }
  }

  private write(message: RpcRequest | RpcNotification | RpcResponse): void {
    this.options.send(`${JSON.stringify(message)}\n`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorBody(error: unknown): RpcErrorBody {
  if (error instanceof RpcError) {
    return error.toBody();
  }
  return { code: RPC_INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) };
}

/** Concatenate the text of every text block in an ACP content array. Pure. */
export function contentBlocksToText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is TextContentBlock => block.type === "text" && typeof (block as TextContentBlock).text === "string")
    .map((block) => block.text)
    .join("");
}

/** Build an `agent_message_chunk` session/update for a span of assistant text. */
export function agentMessageChunk(sessionId: string, text: string): SessionNotification {
  return { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } };
}
