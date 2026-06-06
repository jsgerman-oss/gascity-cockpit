// acp-mayor — expose the GasCity Mayor as an Agent Client Protocol agent.
//
// This is the non-extension build target (cockpit-dc8.5) that lets Zed — and the
// JetBrains / VS Code ACP extensions — talk to the Mayor natively. It is a plain
// Node entrypoint with no `vscode`: it imports the shared **core boundary**
// (`src/core`) for the typed `/v0` client, bridges ACP ⇄ /v0 in ./bridge, and
// frames JSON-RPC over stdio in ./protocol. Same shape as the fleet-status CLI
// (targets/cli) — import core, add an esbuild target, ship. See
// docs/core-boundary.md and docs/acp-mayor.md.
//
// ACP transport invariant: **stdout carries the JSON-RPC stream**. Every
// diagnostic therefore goes to stderr, never stdout. Inbound lines are
// dispatched without awaiting so a `session/cancel` can interrupt the
// `session/prompt` it cancels.
//
// Usage:
//   acp-mayor [endpoint] [--endpoint=URL] [--city=NAME] [--session=ID]
//             [--token=TOKEN] [--permission-mode=MODE] [--timeout=MS] [--help]
import * as core from "../../src/core/index.ts";
import { MayorAgent, type AcpClient, type MayorConfig } from "./bridge.ts";
import {
  JsonRpcPeer,
  LineBuffer,
  METHOD_SESSION_REQUEST_PERMISSION,
  METHOD_SESSION_UPDATE,
} from "./protocol.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAYOR_SESSION = "mayor";

/** Resolved launch options for the adapter. */
export interface AcpMayorOptions {
  /** Supervisor base URL. */
  endpoint: string;
  /** Bearer token for the supervisor, when it requires one. */
  token?: string;
  /** Per-request timeout (ms) for non-streaming calls. */
  timeoutMs: number;
  /** Which Mayor session the adapter proxies. */
  config: MayorConfig;
}

const USAGE = `acp-mayor — expose the GasCity Mayor as an ACP agent (for Zed, JetBrains, …)

Usage:
  acp-mayor [endpoint] [options]

Options:
  endpoint, --endpoint=URL    Supervisor base URL (default: $GASCITY_API_URL or
                              ${core.discovery.DEFAULT_SUPERVISOR_BASE_URL})
  --city=NAME                 Target city (default: $GASCITY_CITY, else the sole city)
  --session=ID                Mayor session id/alias (default: $GASCITY_MAYOR_SESSION or "${DEFAULT_MAYOR_SESSION}")
  --token=TOKEN               Bearer token (default: $GASCITY_API_TOKEN)
  --permission-mode=MODE      Initial session permission mode, e.g. default / acceptEdits / plan
  --timeout=MS                Per-request timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  --help                      Show this help and exit

The agent speaks ACP (JSON-RPC over stdio). Point your editor's external-agent
config at this binary; see the "Use the Mayor from Zed" section of the README.`;

/** Parse argv + env into launch options, a help directive, or a usage error. */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): { kind: "run"; options: AcpMayorOptions } | { kind: "help" } | { kind: "error"; message: string } {
  let endpoint: string | undefined;
  let city: string | undefined;
  let session: string | undefined;
  let token: string | undefined;
  let permissionMode: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  const value = (arg: string, prefix: string): string => arg.slice(prefix.length);

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    } else if (arg.startsWith("--endpoint=")) {
      endpoint = value(arg, "--endpoint=");
    } else if (arg.startsWith("--city=")) {
      city = value(arg, "--city=");
    } else if (arg.startsWith("--session=")) {
      session = value(arg, "--session=");
    } else if (arg.startsWith("--token=")) {
      token = value(arg, "--token=");
    } else if (arg.startsWith("--permission-mode=")) {
      permissionMode = value(arg, "--permission-mode=");
    } else if (arg.startsWith("--timeout=")) {
      const ms = Number(value(arg, "--timeout="));
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

  const config: MayorConfig = {
    mayorSession: session ?? env.GASCITY_MAYOR_SESSION ?? DEFAULT_MAYOR_SESSION,
    ...(city ?? env.GASCITY_CITY ? { cityName: city ?? env.GASCITY_CITY } : {}),
    ...(permissionMode ?? env.GASCITY_PERMISSION_MODE
      ? { permissionMode: permissionMode ?? env.GASCITY_PERMISSION_MODE }
      : {}),
  };

  return {
    kind: "run",
    options: {
      endpoint: endpoint ?? env.GASCITY_API_URL ?? core.discovery.DEFAULT_SUPERVISOR_BASE_URL,
      ...(token ?? env.GASCITY_API_TOKEN ? { token: token ?? env.GASCITY_API_TOKEN } : {}),
      timeoutMs,
      config,
    },
  };
}

/** The stdio-ish streams the server reads/writes. Injectable for tests. */
export interface ServerIO {
  /** Inbound JSON-RPC lines (e.g. `process.stdin`). */
  input: AsyncIterable<string | Uint8Array>;
  /** Outbound JSON-RPC channel (e.g. `process.stdout`). */
  output: { write(chunk: string): void };
  /** Diagnostics channel — never the JSON-RPC stream (e.g. `process.stderr`). */
  log: { write(chunk: string): void };
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wire a {@link MayorAgent} to a {@link JsonRpcPeer} over `io` and pump inbound
 * lines until the input ends. Resolves when the stream closes (the editor
 * disconnected). Pure of `process` — `io` is injected, so a test drives a full
 * round-trip with in-memory streams.
 */
export async function serve(options: AcpMayorOptions, io: ServerIO): Promise<void> {
  const authHeader = core.api.bearerAuthHeader(options.token);
  const client = core.api.createCockpitClient({
    baseUrl: options.endpoint,
    timeoutMs: options.timeoutMs,
    ...(authHeader ? { headers: authHeader } : {}),
  });
  const endpoint: core.api.StreamEndpoint = {
    baseUrl: options.endpoint,
    ...(options.token ? { token: options.token } : {}),
  };

  // The peer and the agent reference each other. The peer's handler closures
  // capture `agent` (declared just below); they only fire once a line arrives,
  // long after construction, so the forward reference is safe.
  const peer = new JsonRpcPeer({
    send: (message) => io.output.write(message),
    onRequest: (method, params) => agent.handleRequest(method, params),
    onNotification: (method, params) => agent.handleNotification(method, params),
    onError: (err) => io.log.write(`acp-mayor: ${errString(err)}\n`),
  });
  const acp: AcpClient = {
    sendUpdate: (note) => peer.notify(METHOD_SESSION_UPDATE, note),
    requestPermission: (params) => peer.request(METHOD_SESSION_REQUEST_PERMISSION, params),
  };
  const agent = new MayorAgent({ client, endpoint, config: options.config, acp });

  const target = options.config.cityName ?? "(auto)";
  io.log.write(`acp-mayor: serving Mayor session '${options.config.mayorSession}' in city ${target} via ${options.endpoint}\n`);

  const lines = new LineBuffer();
  for await (const chunk of io.input) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const line of lines.push(text)) {
      // Do NOT await: a session/cancel notification must be free to interrupt the
      // session/prompt it cancels rather than queue behind it.
      void peer.receive(line);
    }
  }
  const tail = lines.flush();
  if (tail) {
    void peer.receive(tail);
  }
  peer.dispose();
}

/** Default I/O bound to the real process streams. */
function processIO(): ServerIO {
  return {
    input: process.stdin,
    output: { write: (chunk) => void process.stdout.write(chunk) },
    log: { write: (chunk) => void process.stderr.write(chunk) },
  };
}

/** Entry point: parse, then serve over stdio until disconnect. Returns an exit code. */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
  io: ServerIO = processIO(),
): Promise<number> {
  const parsed = parseArgs(argv, env);
  if (parsed.kind === "help") {
    io.log.write(`${USAGE}\n`);
    return 2;
  }
  if (parsed.kind === "error") {
    io.log.write(`acp-mayor: ${parsed.message}\n\n${USAGE}\n`);
    return 1;
  }
  try {
    await serve(parsed.options, io);
    return 0;
  } catch (err) {
    io.log.write(`acp-mayor: ${errString(err)}\n`);
    return 1;
  }
}
