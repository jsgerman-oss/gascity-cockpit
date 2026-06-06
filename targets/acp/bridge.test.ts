import { describe, it, expect } from "vitest";
import * as core from "../../src/core/index.ts";
import {
  MayorAgent,
  AssistantDelta,
  assistantTextSince,
  permissionOptionsFor,
  describePromptForInput,
  type AcpClient,
  type MayorAgentDeps,
} from "./bridge.ts";
import {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  type NewSessionResult,
  type PromptResult,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionNotification,
} from "./protocol.ts";

type ApiResult<T> = core.api.ApiResult<T>;
type SessionStreamEvent = core.api.SessionStreamEvent;
type ConversationTurn = core.api.ConversationTurn;
type PendingInteraction = core.api.PendingInteraction;

// --- result + stream-event builders -----------------------------------------

function ok<T>(data: unknown): ApiResult<T> {
  return { ok: true, data: data as T };
}
function fail<T>(title: string, detail?: string): ApiResult<T> {
  return { ok: false, error: { status: 500, title, ...(detail ? { detail } : {}) } };
}

const IN_TURN = { kind: "activity", activity: "in-turn" } as SessionStreamEvent;
const IDLE = { kind: "activity", activity: "idle" } as SessionStreamEvent;
function turnEvent(turns: ConversationTurn[]): SessionStreamEvent {
  return { kind: "turn", turns, event: { turns } } as unknown as SessionStreamEvent;
}
function pendingEvent(pending: PendingInteraction): SessionStreamEvent {
  return { kind: "pending", pending } as SessionStreamEvent;
}
function streamOf(events: SessionStreamEvent[]): typeof core.api.streamSession {
  return async function* () {
    for (const event of events) {
      yield event;
    }
  };
}

// --- agent harness ----------------------------------------------------------

interface Overrides extends Partial<MayorAgentDeps> {
  cities?: string[];
  transcriptTurns?: ConversationTurn[];
  permissionOutcome?: RequestPermissionResult;
}

function buildAgent(overrides: Overrides = {}) {
  const updates: SessionNotification[] = [];
  const permissionCalls: RequestPermissionParams[] = [];
  const respondCalls: Array<{ city: string; sid: string; input: core.api.RespondInput }> = [];
  const submitCalls: Array<{ message: string; intent?: string }> = [];
  const setModeCalls: Array<{ mode: string }> = [];

  const acp: AcpClient = {
    sendUpdate: (note) => updates.push(note),
    requestPermission: async (params) => {
      permissionCalls.push(params);
      return overrides.permissionOutcome ?? { outcome: { outcome: "selected", optionId: "allow" } };
    },
  };

  const deps: MayorAgentDeps = {
    client: {} as core.api.CockpitClient,
    endpoint: { baseUrl: "http://supervisor.test" },
    config: { mayorSession: "mayor", ...overrides.config },
    acp,
    awaitSubmitOutcome: overrides.awaitSubmitOutcome ?? null,
    listCities:
      overrides.listCities ??
      (async () => ok({ items: (overrides.cities ?? ["hq"]).map((name) => ({ name })) })),
    getSession: overrides.getSession ?? (async () => ok({ title: "Mayor" })),
    getSessionTranscript:
      overrides.getSessionTranscript ?? (async () => ok({ turns: overrides.transcriptTurns ?? [] })),
    getSessionPending: overrides.getSessionPending ?? (async () => ok({ pending: null, supported: true })),
    submitToSession:
      overrides.submitToSession ??
      (async (_client, params) => {
        submitCalls.push({ message: params.message, intent: params.intent });
        return ok({ request_id: "r1" });
      }),
    streamSession: overrides.streamSession ?? streamOf([]),
    respond:
      overrides.respond ??
      (async (_client, city, sid, input) => {
        respondCalls.push({ city, sid, input });
        return ok({});
      }),
    setPermissionMode:
      overrides.setPermissionMode ??
      (async (_client, _city, _sid, mode) => {
        setModeCalls.push({ mode });
        return ok({ title: "Mayor" });
      }),
  };

  return { agent: new MayorAgent(deps), updates, permissionCalls, respondCalls, submitCalls, setModeCalls };
}

async function newSession(agent: MayorAgent): Promise<string> {
  const result = (await agent.handleRequest("session/new", {})) as NewSessionResult;
  return result.sessionId;
}
function emittedText(updates: SessionNotification[]): string {
  return updates
    .map((note) =>
      note.update.sessionUpdate === "agent_message_chunk" && note.update.content.type === "text"
        ? (note.update.content as { text: string }).text
        : "",
    )
    .join("");
}

// --- pure helpers -----------------------------------------------------------

describe("assistant-text projection", () => {
  it("joins non-user turns from the baseline, dropping the echoed prompt", () => {
    const turns: ConversationTurn[] = [
      { role: "user", text: "old" },
      { role: "user", text: "hi" },
      { role: "assistant", text: "Hello" },
    ];
    expect(assistantTextSince(turns, 1)).toBe("Hello");
  });

  it("AssistantDelta streams only the newly-added suffix", () => {
    const delta = new AssistantDelta(0);
    expect(delta.next([{ role: "assistant", text: "Hello" }])).toBe("Hello");
    expect(delta.next([{ role: "assistant", text: "Hello world" }])).toBe(" world");
    expect(delta.next([{ role: "assistant", text: "Hello world" }])).toBe("");
  });
});

describe("permission option mapping", () => {
  it("maps /v0 options verbatim as optionIds and classifies their kind", () => {
    const options = permissionOptionsFor({
      kind: "tool-approval",
      request_id: "p1",
      options: ["allow", "deny", "allow-always"],
    });
    expect(options).toEqual([
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
      { optionId: "allow-always", name: "Allow Always", kind: "allow_always" },
    ]);
  });

  it("falls back to allow/deny when the interaction lists no options", () => {
    const options = permissionOptionsFor({ kind: "tool-approval", request_id: "p2" });
    expect(options.map((o) => o.optionId)).toEqual(["allow", "deny"]);
  });

  it("classifies deny-always and unknown-vocab actions", () => {
    const options = permissionOptionsFor({
      kind: "tool-approval",
      request_id: "p3",
      options: ["deny-always", "frobnicate", "maybe-always"],
    });
    // deny+always → reject_always; unknown vocab → allow_once; unknown+always → allow_always.
    expect(options.map((o) => o.kind)).toEqual(["reject_always", "allow_once", "allow_always"]);
  });

  it("describePromptForInput surfaces the question text", () => {
    expect(describePromptForInput({ kind: "prompt-for-input", request_id: "q1", prompt: "Which branch?" })).toContain(
      "Which branch?",
    );
  });

  it("describePromptForInput still asks for a reply with no prompt text", () => {
    const md = describePromptForInput({ kind: "prompt-for-input", request_id: "q2" });
    expect(md).toContain("needs your input");
    expect(md).toContain("Reply with your answer");
  });
});

// --- ACP request mapping ----------------------------------------------------

describe("initialize", () => {
  it("advertises protocol version 1 and no session persistence / auth", async () => {
    const { agent } = buildAgent();
    const result = (await agent.handleRequest("initialize", { protocolVersion: 1 })) as {
      protocolVersion: number;
      agentCapabilities: { loadSession: boolean };
      authMethods: unknown[];
    };
    expect(result.protocolVersion).toBe(1);
    expect(result.agentCapabilities.loadSession).toBe(false);
    expect(result.authMethods).toEqual([]);
  });
});

describe("session/new", () => {
  it("validates the Mayor session and returns a city-scoped session id", async () => {
    const { agent } = buildAgent({ config: { mayorSession: "mayor", cityName: "hq" } });
    const result = (await agent.handleRequest("session/new", { cwd: "/repo" })) as NewSessionResult;
    expect(result.sessionId).toBe("mayor-hq-1");
  });

  it("auto-resolves the city when the supervisor serves exactly one", async () => {
    const { agent } = buildAgent({ cities: ["only-city"] });
    const result = (await agent.handleRequest("session/new", {})) as NewSessionResult;
    expect(result.sessionId).toBe("mayor-only-city-1");
  });

  it("refuses to guess when multiple cities exist", async () => {
    const { agent } = buildAgent({ cities: ["a", "b"] });
    await expect(agent.handleRequest("session/new", {})).rejects.toMatchObject({ code: RPC_INVALID_PARAMS });
  });

  it("errors when the supervisor serves no cities", async () => {
    const { agent } = buildAgent({ cities: [] });
    await expect(agent.handleRequest("session/new", {})).rejects.toMatchObject({ code: RPC_INVALID_PARAMS });
  });

  it("surfaces a listCities failure when resolving the city", async () => {
    const { agent } = buildAgent({ config: { mayorSession: "mayor" }, listCities: async () => fail("supervisor down") });
    await expect(agent.handleRequest("session/new", {})).rejects.toMatchObject({ code: RPC_INTERNAL_ERROR });
  });

  it("errors when the Mayor session is missing", async () => {
    const { agent } = buildAgent({ config: { mayorSession: "mayor", cityName: "hq" }, getSession: async () => fail("not found") });
    await expect(agent.handleRequest("session/new", {})).rejects.toMatchObject({ code: RPC_INVALID_PARAMS });
  });

  it("applies a configured permission mode", async () => {
    const { agent, setModeCalls } = buildAgent({ config: { mayorSession: "mayor", cityName: "hq", permissionMode: "plan" } });
    await agent.handleRequest("session/new", {});
    expect(setModeCalls).toEqual([{ mode: "plan" }]);
  });
});

describe("session/prompt — submit + stream → agent_message_chunk", () => {
  it("submits the prompt text and streams the assistant reply to a clean end_turn", async () => {
    const { agent, submitCalls, updates } = buildAgent({
      streamSession: streamOf([
        IN_TURN,
        turnEvent([
          { role: "user", text: "hi" },
          { role: "assistant", text: "Hello there" },
        ]),
        IDLE,
      ]),
    });
    const sessionId = await newSession(agent);
    const result = (await agent.handleRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    })) as PromptResult;

    expect(submitCalls).toEqual([{ message: "hi", intent: "default" }]);
    expect(emittedText(updates)).toBe("Hello there");
    expect(result.stopReason).toBe("end_turn");
  });

  it("streams incremental deltas across growing turn snapshots", async () => {
    const { agent, updates } = buildAgent({
      streamSession: streamOf([
        IN_TURN,
        turnEvent([{ role: "assistant", text: "Hello" }]),
        turnEvent([{ role: "assistant", text: "Hello world" }]),
        IDLE,
      ]),
    });
    const sessionId = await newSession(agent);
    await agent.handleRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    const chunks = updates.map((n) =>
      n.update.sessionUpdate === "agent_message_chunk" ? (n.update.content as { text: string }).text : "",
    );
    expect(chunks).toEqual(["Hello", " world"]);
  });

  it("rejects a prompt with no text content", async () => {
    const { agent } = buildAgent();
    const sessionId = await newSession(agent);
    await expect(
      agent.handleRequest("session/prompt", { sessionId, prompt: [{ type: "image", data: "x" }] }),
    ).rejects.toMatchObject({ code: RPC_INVALID_PARAMS });
  });

  it("rejects a prompt for an unknown session", async () => {
    const { agent } = buildAgent();
    await expect(
      agent.handleRequest("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toMatchObject({ code: RPC_INVALID_PARAMS });
  });

  it("surfaces a submit failure as an internal error", async () => {
    const { agent } = buildAgent({ submitToSession: async () => fail("loop busy", "try again") });
    const sessionId = await newSession(agent);
    await expect(
      agent.handleRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toMatchObject({ message: "try again" });
  });
});

describe("session/prompt — tool-approval ⇄ request_permission", () => {
  it("asks the client for permission and forwards the selection to /v0 respond", async () => {
    const { agent, permissionCalls, respondCalls } = buildAgent({
      permissionOutcome: { outcome: { outcome: "selected", optionId: "allow" } },
      streamSession: streamOf([
        IN_TURN,
        pendingEvent({ kind: "tool-approval", request_id: "tc1", prompt: "Run npm test?", options: ["allow", "deny"] }),
        turnEvent([{ role: "assistant", text: "Done." }]),
        IDLE,
      ]),
    });
    const sessionId = await newSession(agent);
    const result = (await agent.handleRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "ship it" }],
    })) as PromptResult;

    expect(permissionCalls).toHaveLength(1);
    expect(permissionCalls[0].toolCall.toolCallId).toBe("tc1");
    expect(permissionCalls[0].options.map((o) => o.optionId)).toEqual(["allow", "deny"]);
    expect(respondCalls).toEqual([{ city: "hq", sid: "mayor", input: { action: "allow", requestId: "tc1" } }]);
    expect(result.stopReason).toBe("end_turn");
  });

  it("denies and cancels the turn when the client cancels the permission prompt", async () => {
    const { agent, respondCalls } = buildAgent({
      permissionOutcome: { outcome: { outcome: "cancelled" } },
      streamSession: streamOf([
        IN_TURN,
        pendingEvent({ kind: "tool-approval", request_id: "tc2", options: ["allow", "deny"] }),
      ]),
    });
    const sessionId = await newSession(agent);
    const result = (await agent.handleRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    })) as PromptResult;

    expect(respondCalls[0].input.action).toBe("deny");
    expect(result.stopReason).toBe("cancelled");
  });
});

describe("session/prompt — prompt-for-input", () => {
  it("surfaces the question and ends the turn, then routes the next prompt as the answer", async () => {
    // First turn streams a prompt-for-input; the agent surfaces it and ends.
    let pendingNow: PendingInteraction | null = null;
    const { agent, updates, respondCalls, submitCalls } = buildAgent({
      getSessionPending: async () => ok({ pending: pendingNow, supported: true }),
      streamSession: streamOf([
        IN_TURN,
        pendingEvent({ kind: "prompt-for-input", request_id: "q1", prompt: "Which environment?" }),
      ]),
    });
    const sessionId = await newSession(agent);
    const first = (await agent.handleRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "deploy" }],
    })) as PromptResult;

    expect(emittedText(updates)).toContain("Which environment?");
    expect(first.stopReason).toBe("end_turn");

    // Now the session is parked on that prompt-for-input; the next prompt answers it.
    pendingNow = { kind: "prompt-for-input", request_id: "q1", prompt: "Which environment?", options: ["submit"] };
    await agent.handleRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "staging" }] });

    // Only the first prompt submitted; the second was routed to /v0 respond as the answer.
    expect(submitCalls).toEqual([{ message: "deploy", intent: "default" }]);
    expect(respondCalls).toEqual([{ city: "hq", sid: "mayor", input: { action: "submit", text: "staging", requestId: "q1" } }]);
  });
});

describe("session/cancel", () => {
  it("aborts an in-flight turn and resolves it as cancelled", async () => {
    let signalWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      signalWaiting = resolve;
    });
    const hanging: typeof core.api.streamSession = async function* (_endpoint, _ref, options) {
      yield IN_TURN;
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) {
          resolve();
          return;
        }
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        signalWaiting();
      });
    };

    const { agent } = buildAgent({ streamSession: hanging });
    const sessionId = await newSession(agent);
    const promptPromise = agent.handleRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "long task" }],
    }) as Promise<PromptResult>;

    await waiting; // the turn is now streaming and parked on the live stream
    agent.handleNotification("session/cancel", { sessionId });
    expect((await promptPromise).stopReason).toBe("cancelled");
  });
});

describe("session/prompt — outcome backstop + stale pending", () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("appends an error note when the city-event outcome reports a failure", async () => {
    let resolveOutcome!: (outcome: core.api.SubmitOutcome) => void;
    const awaitSubmitOutcome: typeof core.api.awaitSubmitOutcome = () =>
      new Promise<core.api.SubmitOutcome>((res) => {
        resolveOutcome = res;
      });
    // A stream that stays open until the outcome backstop aborts it.
    const hanging: typeof core.api.streamSession = async function* (_endpoint, _ref, options) {
      yield IN_TURN;
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    };

    const { agent, updates } = buildAgent({ awaitSubmitOutcome, streamSession: hanging });
    const sessionId = await newSession(agent);
    const promptPromise = agent.handleRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    }) as Promise<PromptResult>;
    await tick(); // the turn is now streaming and parked on the live stream

    resolveOutcome({ kind: "failed", errorCode: "boom", errorMessage: "server boom" });
    const result = await promptPromise;

    expect(emittedText(updates)).toContain("server boom");
    expect(result.stopReason).toBe("end_turn");
  });

  it("ignores a re-delivered pending interaction it already answered", async () => {
    const { agent, permissionCalls, respondCalls } = buildAgent({
      permissionOutcome: { outcome: { outcome: "selected", optionId: "allow" } },
      streamSession: streamOf([
        IN_TURN,
        pendingEvent({ kind: "tool-approval", request_id: "dup", options: ["allow", "deny"] }),
        // Same request_id again — a stale re-delivery the agent must not re-prompt for.
        pendingEvent({ kind: "tool-approval", request_id: "dup", options: ["allow", "deny"] }),
        turnEvent([{ role: "assistant", text: "Done." }]),
        IDLE,
      ]),
    });
    const sessionId = await newSession(agent);
    const result = (await agent.handleRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    })) as PromptResult;

    expect(permissionCalls).toHaveLength(1); // the duplicate did not trigger a second prompt
    expect(respondCalls).toHaveLength(1);
    expect(result.stopReason).toBe("end_turn");
  });

  it("surfaces a non-abort stream error as an internal error", async () => {
    const boom: typeof core.api.streamSession = async function* () {
      yield IN_TURN;
      throw new Error("stream died");
    };
    const { agent } = buildAgent({ streamSession: boom });
    const sessionId = await newSession(agent);
    await expect(
      agent.handleRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] }),
    ).rejects.toMatchObject({ message: "stream died" });
  });

  it("ignores unknown stream event kinds and still completes", async () => {
    const { agent, updates } = buildAgent({
      streamSession: streamOf([
        IN_TURN,
        { kind: "heartbeat" } as SessionStreamEvent, // an event kind the bridge doesn't project
        turnEvent([{ role: "assistant", text: "ok" }]),
        IDLE,
      ]),
    });
    const sessionId = await newSession(agent);
    const result = (await agent.handleRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    })) as PromptResult;
    expect(emittedText(updates)).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
  });

  it("starts the delta from zero when the transcript can't be read", async () => {
    const { agent, updates } = buildAgent({
      getSessionTranscript: async () => fail("no transcript"),
      streamSession: streamOf([IN_TURN, turnEvent([{ role: "assistant", text: "Hi" }]), IDLE]),
    });
    const sessionId = await newSession(agent);
    await agent.handleRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    expect(emittedText(updates)).toBe("Hi");
  });

  it("completes via a succeeded outcome backstop and forwards the event cursor", async () => {
    let resolveOutcome!: (outcome: core.api.SubmitOutcome) => void;
    const seenRefs: Array<{ eventCursor?: string }> = [];
    const awaitSubmitOutcome: typeof core.api.awaitSubmitOutcome = (_endpoint, ref) => {
      seenRefs.push(ref as { eventCursor?: string });
      return new Promise<core.api.SubmitOutcome>((res) => {
        resolveOutcome = res;
      });
    };
    const hanging: typeof core.api.streamSession = async function* (_endpoint, _ref, options) {
      yield IN_TURN;
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const { agent } = buildAgent({
      awaitSubmitOutcome,
      submitToSession: async () => ok({ request_id: "r9", event_cursor: "c1" }),
      streamSession: hanging,
    });
    const sessionId = await newSession(agent);
    const promptPromise = agent.handleRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    }) as Promise<PromptResult>;
    await tick();

    resolveOutcome({ kind: "succeeded", type: "request.result.session.submit" });
    const result = await promptPromise;
    expect(result.stopReason).toBe("end_turn");
    expect(seenRefs[0]?.eventCursor).toBe("c1"); // the submit's event cursor was forwarded
  });
});

describe("unsupported methods", () => {
  it("rejects session/load (no session persistence)", async () => {
    const { agent } = buildAgent();
    await expect(agent.handleRequest("session/load", {})).rejects.toMatchObject({ code: RPC_METHOD_NOT_FOUND });
  });
  it("rejects an unknown method", async () => {
    const { agent } = buildAgent();
    await expect(agent.handleRequest("frobnicate", {})).rejects.toMatchObject({ code: RPC_METHOD_NOT_FOUND });
  });
});
