// Tests for the MCP server's I/O shell: argument parsing, tool-context building,
// the stdio pump, and the `run` entry point. `serve`/`run` take injectable
// streams (the Seam-1 pattern, mirroring the acp-mayor adapter), so the whole
// shell drives in plain Node with in-memory streams — no real stdin/stdout.
import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import * as core from "../../src/core/index.ts";
import { buildContext, parseArgs, run, serve, type ServeStreams } from "./server.ts";
import { createDispatcher, PARSE_ERROR } from "./protocol.ts";
import { TOOLS } from "./tools.ts";

const DEFAULT_ENDPOINT = core.discovery.DEFAULT_SUPERVISOR_BASE_URL;

/** Capture every line written to the output stream. */
function collector(): { output: ServeStreams["output"]; writes: string[] } {
  const writes: string[] = [];
  const output = { write: (chunk: string | Uint8Array) => void writes.push(chunk.toString()) };
  return { output: output as unknown as ServeStreams["output"], writes };
}

/** A readable stream over the given chunks (newline framing is the caller's job). */
function inputOf(chunks: string[]): ServeStreams["input"] {
  return Readable.from(chunks) as unknown as ServeStreams["input"];
}

describe("parseArgs", () => {
  it("defaults endpoint, timeout, and allowWrites with no args", () => {
    expect(parseArgs([], {})).toEqual({
      kind: "run",
      options: { endpoint: DEFAULT_ENDPOINT, timeoutMs: 15_000, allowWrites: false },
    });
  });

  it("reads a positional endpoint", () => {
    const parsed = parseArgs(["http://host:9"], {});
    expect(parsed.kind === "run" && parsed.options.endpoint).toBe("http://host:9");
  });

  it("reads the --endpoint= and --timeout= flag forms", () => {
    expect(parseArgs(["--endpoint=http://x", "--timeout=500"], {})).toMatchObject({
      kind: "run",
      options: { endpoint: "http://x", timeoutMs: 500 },
    });
  });

  it("enables writes via the flag", () => {
    const parsed = parseArgs(["--allow-writes"], {});
    expect(parsed.kind === "run" && parsed.options.allowWrites).toBe(true);
  });

  it("reads the write gate from the environment (truthy variants only)", () => {
    for (const value of ["1", "true", "YES", " on "]) {
      const parsed = parseArgs([], { GASCITY_MCP_ALLOW_WRITES: value });
      expect(parsed.kind === "run" && parsed.options.allowWrites, value).toBe(true);
    }
    for (const value of ["0", "off", "", undefined]) {
      const parsed = parseArgs([], { GASCITY_MCP_ALLOW_WRITES: value });
      expect(parsed.kind === "run" && parsed.options.allowWrites, String(value)).toBe(false);
    }
  });

  it("falls back to the env endpoint", () => {
    const parsed = parseArgs([], { GASCITY_API_URL: "http://env:1" });
    expect(parsed.kind === "run" && parsed.options.endpoint).toBe("http://env:1");
  });

  it("rejects an invalid timeout", () => {
    expect(parseArgs(["--timeout=nope"], {})).toEqual({ kind: "error", message: "invalid --timeout: --timeout=nope" });
  });

  it("rejects an unknown option", () => {
    expect(parseArgs(["--bogus"], {})).toEqual({ kind: "error", message: "unknown option: --bogus" });
  });

  it("rejects a second positional argument", () => {
    expect(parseArgs(["http://a", "extra"], {})).toEqual({ kind: "error", message: "unexpected argument: extra" });
  });

  it("returns help for --help and -h", () => {
    expect(parseArgs(["--help"], {})).toEqual({ kind: "help" });
    expect(parseArgs(["-h"], {})).toEqual({ kind: "help" });
  });
});

describe("buildContext", () => {
  it("builds a tool context with a normalized endpoint and the write gate", () => {
    const ctx = buildContext({ endpoint: "http://host:9/", timeoutMs: 1000, allowWrites: true });
    expect(ctx.endpoint).toBe(core.api.normalizeBaseUrl("http://host:9/"));
    expect(ctx.allowWrites).toBe(true);
    expect(ctx.repo).toBeInstanceOf(core.beads.BeadsRepository);
    expect(ctx.client).toBeTypeOf("object");
  });
});

describe("serve", () => {
  // The dispatcher answers `ping` and notifications without touching the context.
  const dispatcher = createDispatcher({
    serverInfo: { name: "t", version: "0" },
    tools: TOOLS,
    context: {} as never,
  });

  it("answers a ping and skips blank lines", async () => {
    const { output, writes } = collector();
    await serve(dispatcher, { input: inputOf(["\n", '{"jsonrpc":"2.0","id":1,"method":"ping"}\n']), output });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({ id: 1, result: {} });
  });

  it("writes a parse error for a malformed line", async () => {
    const { output, writes } = collector();
    await serve(dispatcher, { input: inputOf(["{not json\n"]), output });
    expect(JSON.parse(writes[0]).error.code).toBe(PARSE_ERROR);
  });

  it("writes nothing for a notification", async () => {
    const { output, writes } = collector();
    await serve(dispatcher, { input: inputOf(['{"jsonrpc":"2.0","method":"notifications/initialized"}\n']), output });
    expect(writes).toHaveLength(0);
  });
});

describe("run", () => {
  it("prints usage and returns 2 for --help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await run(["--help"], {})).toBe(2);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("prints the error and returns 1 for a bad option", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(["--nope"], {})).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("builds a server and serves to a clean exit (0) over injected streams", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { output, writes } = collector();
    const code = await run(["http://stub", "--allow-writes"], {}, {
      input: inputOf(['{"jsonrpc":"2.0","id":7,"method":"ping"}\n']),
      output,
    });
    expect(code).toBe(0);
    expect(JSON.parse(writes[0])).toMatchObject({ id: 7 });
    // The startup banner (writes ENABLED) went to stderr, not the JSON-RPC stream.
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
