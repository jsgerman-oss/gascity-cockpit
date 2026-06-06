import { describe, it, expect } from "vitest";
import * as core from "../../src/core/index.ts";
import { parseArgs, run, serve, type AcpMayorOptions, type ServerIO } from "./acp-mayor.ts";
import { MayorAgent, type AcpClient } from "./bridge.ts";
import {
  JsonRpcPeer,
  METHOD_SESSION_REQUEST_PERMISSION,
  METHOD_SESSION_UPDATE,
  type NewSessionResult,
  type PromptResult,
  type SessionNotification,
} from "./protocol.ts";

const DEFAULT_ENDPOINT = core.discovery.DEFAULT_SUPERVISOR_BASE_URL;

describe("parseArgs", () => {
  it("defaults endpoint, session, and timeout with no args", () => {
    const parsed = parseArgs([], {});
    expect(parsed).toMatchObject({
      kind: "run",
      options: { endpoint: DEFAULT_ENDPOINT, timeoutMs: 30_000, config: { mayorSession: "mayor" } },
    });
    if (parsed.kind === "run") {
      expect(parsed.options.config.cityName).toBeUndefined();
      expect(parsed.options.token).toBeUndefined();
    }
  });

  it("reads a positional endpoint and the named flags", () => {
    const parsed = parseArgs(
      ["http://host:9000", "--city=hq", "--session=mayor-2", "--token=secret", "--permission-mode=plan", "--timeout=5000"],
      {},
    );
    expect(parsed).toEqual({
      kind: "run",
      options: {
        endpoint: "http://host:9000",
        token: "secret",
        timeoutMs: 5000,
        config: { mayorSession: "mayor-2", cityName: "hq", permissionMode: "plan" },
      },
    });
  });

  it("falls back to environment variables", () => {
    const parsed = parseArgs([], {
      GASCITY_API_URL: "http://env:1",
      GASCITY_CITY: "envcity",
      GASCITY_MAYOR_SESSION: "envsession",
      GASCITY_API_TOKEN: "envtoken",
      GASCITY_PERMISSION_MODE: "acceptEdits",
    });
    expect(parsed).toMatchObject({
      kind: "run",
      options: {
        endpoint: "http://env:1",
        token: "envtoken",
        config: { mayorSession: "envsession", cityName: "envcity", permissionMode: "acceptEdits" },
      },
    });
  });

  it("lets flags win over the environment", () => {
    const parsed = parseArgs(["--city=flagcity"], { GASCITY_CITY: "envcity" });
    expect(parsed.kind === "run" && parsed.options.config.cityName).toBe("flagcity");
  });

  it("rejects an invalid timeout", () => {
    expect(parseArgs(["--timeout=nope"], {})).toEqual({ kind: "error", message: "invalid --timeout: --timeout=nope" });
  });

  it("rejects an unknown option", () => {
    expect(parseArgs(["--bogus"], {})).toEqual({ kind: "error", message: "unknown option: --bogus" });
  });

  it("returns help for --help", () => {
    expect(parseArgs(["--help"], {})).toEqual({ kind: "help" });
  });

  it("reads the --endpoint= flag form", () => {
    const parsed = parseArgs(["--endpoint=http://flag:1"], {});
    expect(parsed.kind === "run" && parsed.options.endpoint).toBe("http://flag:1");
  });

  it("rejects a second positional argument", () => {
    expect(parseArgs(["http://a", "extra"], {})).toEqual({ kind: "error", message: "unexpected argument: extra" });
  });
});

// --- serve() / run() over in-memory streams ---------------------------------
// serve/run inject ServerIO, so a full stdio round-trip drives in plain Node.
// `initialize` is answered by the bridge with no network, so these need no /v0.

const OPTIONS: AcpMayorOptions = {
  endpoint: "http://stub",
  timeoutMs: 1000,
  config: { mayorSession: "mayor", cityName: "hq" },
};

/** In-memory ServerIO: feed `lines` as input, capture output/log writes. */
function memoryIO(lines: string[]): { io: ServerIO; out: string[]; log: string[] } {
  const out: string[] = [];
  const log: string[] = [];
  return {
    io: {
      input: (async function* () {
        for (const line of lines) yield line;
      })(),
      output: { write: (chunk) => out.push(chunk) },
      log: { write: (chunk) => log.push(chunk) },
    },
    out,
    log,
  };
}

describe("serve", () => {
  it("answers an initialize request and resolves when the input closes", async () => {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const { io, out, log } = memoryIO([`${init}\n`]);
    await serve(OPTIONS, io);
    const responses = out.map((line) => JSON.parse(line) as { id: number; result?: { protocolVersion: number } });
    expect(responses[0].result?.protocolVersion).toBe(1);
    expect(log.join("")).toContain("serving Mayor session 'mayor'"); // startup diagnostic to stderr
  });

  it("flushes a final unterminated line at EOF", async () => {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" });
    const { io, out } = memoryIO([init]); // no trailing newline → exercised by flush()
    await serve(OPTIONS, io);
    expect(out.some((line) => (JSON.parse(line) as { id?: number }).id === 2)).toBe(true);
  });

  it("decodes byte-chunk input as well as strings", async () => {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize" });
    const out: string[] = [];
    const io: ServerIO = {
      input: (async function* () {
        yield new TextEncoder().encode(`${init}\n`);
      })(),
      output: { write: (chunk) => out.push(chunk) },
      log: { write: () => {} },
    };
    await serve(OPTIONS, io);
    expect(out.some((line) => (JSON.parse(line) as { id?: number }).id === 3)).toBe(true);
  });
});

describe("run", () => {
  it("returns 2 and prints usage for --help", async () => {
    const { io, log } = memoryIO([]);
    expect(await run(["--help"], {}, io)).toBe(2);
    expect(log.join("")).toContain("acp-mayor");
  });

  it("returns 1 and prints the error for a bad option", async () => {
    const { io, log } = memoryIO([]);
    expect(await run(["--nope"], {}, io)).toBe(1);
    expect(log.join("")).toContain("unknown option");
  });

  it("serves to a clean exit (0) when the input stream closes", async () => {
    const { io } = memoryIO([]); // empty input → serve resolves immediately
    expect(await run(["http://stub"], {}, io)).toBe(0);
  });

  it("returns 1 and logs when serving throws", async () => {
    const log: string[] = [];
    const io: ServerIO = {
      // eslint-disable-next-line require-yield -- intentionally errors before emitting any line
      input: (async function* () {
        throw new Error("io exploded");
      })(),
      output: { write: () => {} },
      log: { write: (chunk) => log.push(chunk) },
    };
    expect(await run(["http://stub"], {}, io)).toBe(1);
    expect(log.join("")).toContain("io exploded");
  });

  it("binds the real process streams by default (help path needs no stdin)", async () => {
    // No io argument → run() constructs processIO(); --help returns before reading stdin.
    expect(await run(["--help"], {})).toBe(2);
  });
});

// --- transport round-trip ---------------------------------------------------
// Drive a real JSON-RPC exchange over two wired peers — the editor (client) and
// the adapter (server) — against a stubbed /v0. Proves protocol framing + the
// bridge mapping interoperate end-to-end: initialize → session/new →
// session/prompt with streamed assistant text and a clean end_turn.

type SessionStreamEvent = core.api.SessionStreamEvent;
function ok<T>(data: unknown): core.api.ApiResult<T> {
  return { ok: true, data: data as T };
}

describe("ACP transport round-trip against a stub /v0", () => {
  it("initializes, opens a session, and streams a prompt reply to end_turn", async () => {
    const streamEvents: SessionStreamEvent[] = [
      { kind: "activity", activity: "in-turn" } as SessionStreamEvent,
      { kind: "turn", turns: [{ role: "assistant", text: "Hi from the Mayor" }], event: {} } as unknown as SessionStreamEvent,
      { kind: "activity", activity: "idle" } as SessionStreamEvent,
    ];

    const updates: SessionNotification[] = [];

    // The adapter side: a peer dispatching into the MayorAgent. Its closures
    // capture `agent` / `clientPeer` (declared below) — deferred, so safe.
    const serverPeer: JsonRpcPeer = new JsonRpcPeer({
      send: (msg) => void clientPeer.receive(msg.trimEnd()),
      onRequest: (method, params) => agent.handleRequest(method, params),
      onNotification: (method, params) => agent.handleNotification(method, params),
    });
    const acp: AcpClient = {
      sendUpdate: (note) => serverPeer.notify(METHOD_SESSION_UPDATE, note),
      requestPermission: (params) => serverPeer.request(METHOD_SESSION_REQUEST_PERMISSION, params),
    };
    const agent = new MayorAgent({
      client: {} as core.api.CockpitClient,
      endpoint: { baseUrl: "http://stub" },
      config: { mayorSession: "mayor", cityName: "hq" },
      acp,
      awaitSubmitOutcome: null,
      listCities: async () => ok({ items: [{ name: "hq" }] }),
      getSession: async () => ok({ title: "Mayor" }),
      getSessionTranscript: async () => ok({ turns: [] }),
      getSessionPending: async () => ok({ pending: null, supported: true }),
      submitToSession: async () => ok({ request_id: "r1" }),
      streamSession: async function* () {
        for (const event of streamEvents) {
          yield event;
        }
      },
      respond: async () => ok({}),
      setPermissionMode: async () => ok({ title: "Mayor" }),
    });

    // The editor side: collects session/update notifications.
    const clientPeer: JsonRpcPeer = new JsonRpcPeer({
      send: (msg) => void serverPeer.receive(msg.trimEnd()),
      onRequest: async () => null,
      onNotification: (method, params) => {
        if (method === METHOD_SESSION_UPDATE) {
          updates.push(params as SessionNotification);
        }
      },
    });

    const init = (await clientPeer.request("initialize", { protocolVersion: 1 })) as { protocolVersion: number };
    expect(init.protocolVersion).toBe(1);

    const created = (await clientPeer.request("session/new", { cwd: "/repo" })) as NewSessionResult;
    expect(created.sessionId).toBe("mayor-hq-1");

    const prompt = (await clientPeer.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    })) as PromptResult;
    expect(prompt.stopReason).toBe("end_turn");

    const text = updates
      .map((n) => (n.update.sessionUpdate === "agent_message_chunk" ? (n.update.content as { text: string }).text : ""))
      .join("");
    expect(text).toBe("Hi from the Mayor");
  });
});
