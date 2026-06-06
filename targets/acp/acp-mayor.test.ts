import { describe, it, expect } from "vitest";
import * as core from "../../src/core/index.ts";
import { parseArgs } from "./acp-mayor.ts";
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
