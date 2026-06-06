// mcp-gascity — an MCP context server exposing a gascity supervisor's /v0 API as
// tools, over stdio, to any MCP client (Zed, VS Code Copilot, Claude Code, …).
//
// This is the I/O shell of the MCP target: argument parsing, building the tool
// context against the shared **core boundary** (`src/core`), and pumping
// newline-delimited JSON-RPC between stdin/stdout and the pure dispatcher
// (./protocol.ts). The tools themselves are in ./tools.ts. Like the CLI target,
// the logic worth testing — `parseArgs`, `buildContext` — is exported and
// side-effect-free; only `run`/`serve` touch real streams. See
// docs/mcp-context-server.md and docs/core-boundary.md.
//
// stdout carries the JSON-RPC protocol and MUST stay clean: every diagnostic
// goes to stderr.
import * as readline from "node:readline";
import * as core from "../../src/core/index.ts";
import { TOOLS, type ToolContext } from "./tools.ts";
import { createDispatcher, PARSE_ERROR, type Dispatcher, type JsonRpcResponse } from "./protocol.ts";

/** Server identity advertised to clients in the `initialize` handshake. */
export const SERVER_NAME = "gascity";
export const SERVER_VERSION = "0.1.0";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface ServerOptions {
  endpoint: string;
  timeoutMs: number;
  allowWrites: boolean;
}

const USAGE = `mcp-gascity — MCP context server over a gascity /v0 supervisor

Usage:
  mcp-gascity [endpoint] [--endpoint=URL] [--timeout=MS] [--allow-writes] [--help]
  GASCITY_API_URL=http://host:port mcp-gascity

Speaks the Model Context Protocol over stdio. Point any MCP client at this
binary (see docs/mcp-context-server.md for Zed / Copilot / Claude Code setup).

Options:
  endpoint, --endpoint=URL  Supervisor base URL (default: $GASCITY_API_URL or
                            ${core.discovery.DEFAULT_SUPERVISOR_BASE_URL})
  --timeout=MS              Per-request timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  --allow-writes            Enable the mutating sling tool (also: GASCITY_MCP_ALLOW_WRITES=1)
  --help                    Show this help and exit

Read tools: fleet_status, query_beads, merge_queue, telemetry, recent_events.
Write tool (gated): sling_bead.`;

/** Truthy values for the GASCITY_MCP_ALLOW_WRITES env opt-in. */
function envAllowsWrites(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Parse argv into {@link ServerOptions}, a help directive, or a usage error. */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): { kind: "run"; options: ServerOptions } | { kind: "help" } | { kind: "error"; message: string } {
  let endpoint: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let allowWrites = envAllowsWrites(env.GASCITY_MCP_ALLOW_WRITES);

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    if (arg === "--allow-writes") {
      allowWrites = true;
    } else if (arg.startsWith("--endpoint=")) {
      endpoint = arg.slice("--endpoint=".length);
    } else if (arg.startsWith("--timeout=")) {
      const ms = Number(arg.slice("--timeout=".length));
      if (!Number.isFinite(ms) || ms < 0) {
        return { kind: "error", message: `invalid --timeout: ${arg}` };
      }
      timeoutMs = ms;
    } else if (arg.startsWith("-")) {
      return { kind: "error", message: `unknown option: ${arg}` };
    } else if (endpoint === undefined) {
      endpoint = arg;
    } else {
      return { kind: "error", message: `unexpected argument: ${arg}` };
    }
  }

  return {
    kind: "run",
    options: {
      endpoint: endpoint ?? env.GASCITY_API_URL ?? core.discovery.DEFAULT_SUPERVISOR_BASE_URL,
      timeoutMs,
      allowWrites,
    },
  };
}

/** Build the tool context (typed client + bead repository) for a set of options. */
export function buildContext(options: ServerOptions): ToolContext {
  const client = core.api.createCockpitClient({ baseUrl: options.endpoint, timeoutMs: options.timeoutMs });
  const repo = new core.beads.BeadsRepository({ getClient: () => client });
  return {
    endpoint: core.api.normalizeBaseUrl(options.endpoint),
    client,
    repo,
    allowWrites: options.allowWrites,
  };
}

/** Streams the stdio loop reads from / writes to (injectable for clarity). */
export interface ServeStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

function writeResponse(output: NodeJS.WritableStream, response: JsonRpcResponse): void {
  output.write(`${JSON.stringify(response)}\n`);
}

/**
 * Pump newline-delimited JSON-RPC from `input` through the dispatcher to
 * `output`, one message at a time. Resolves when the input stream ends.
 */
export async function serve(dispatcher: Dispatcher, streams: ServeStreams): Promise<void> {
  const rl = readline.createInterface({ input: streams.input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      writeResponse(streams.output, { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
      continue;
    }

    const response = await dispatcher.handle(message);
    if (response) writeResponse(streams.output, response);
  }
}

/** Entry point: parse args, then either print help or serve over stdio. */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<number> {
  const parsed = parseArgs(argv, env);
  if (parsed.kind === "help") {
    // Not serving — help to stdout is fine and conventional.
    console.log(USAGE);
    return 2;
  }
  if (parsed.kind === "error") {
    console.error(`mcp-gascity: ${parsed.message}\n\n${USAGE}`);
    return 1;
  }

  const context = buildContext(parsed.options);
  const dispatcher = createDispatcher({
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    tools: TOOLS,
    context,
  });

  console.error(
    `[mcp-gascity] serving over stdio against ${context.endpoint} ` +
      `(writes ${parsed.options.allowWrites ? "ENABLED" : "disabled"}, ${TOOLS.length} tools)`,
  );

  await serve(dispatcher, { input: process.stdin, output: process.stdout });
  return 0;
}
