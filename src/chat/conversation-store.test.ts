import { describe, expect, it } from "vitest";
import { createCockpitClient } from "../api/client";
import type { SessionStreamEvent } from "../api/index.ts";
import { jsonResponse, mockFetch, problemResponse } from "../test/helpers";
import { ConversationStore, type ConversationStoreDeps } from "./conversation-store.ts";

const ENDPOINT = { baseUrl: "http://api.test", token: null };
const CITY = "blackrim-hq";
const SID = "mayor-1";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A push-driven async stream so tests control when each event reaches the store. */
function controllableStream() {
  const queue: SessionStreamEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  async function* gen(): AsyncGenerator<SessionStreamEvent, void, unknown> {
    for (;;) {
      while (queue.length) {
        yield queue.shift()!;
      }
      if (done) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    gen,
    push(event: SessionStreamEvent) {
      queue.push(event);
      wake?.();
      wake = null;
    },
    close() {
      done = true;
      wake?.();
      wake = null;
    },
  };
}

/** Build a store whose client routes responses by path suffix. */
function makeStore(
  handler: (path: string, req: Request) => Response,
  overrides: Partial<ConversationStoreDeps> = {},
) {
  const { fetch, calls } = mockFetch((req) => handler(new URL(req.url).pathname, req));
  const client = createCockpitClient({ baseUrl: ENDPOINT.baseUrl, fetch });
  const store = new ConversationStore({
    client,
    endpoint: ENDPOINT,
    cityName: CITY,
    sessionId: SID,
    awaitSubmitOutcome: null,
    ...overrides,
  });
  return { store, calls };
}

describe("ConversationStore.load", () => {
  it("seeds turns, title, provider, capabilities, permission mode, and pending", async () => {
    const { store } = makeStore((path) => {
      if (path.endsWith("/transcript")) {
        return jsonResponse({ format: "conversation", id: SID, provider: "claude", template: "mayor", turns: [{ role: "assistant", text: "hi" }] });
      }
      if (path.endsWith("/pending")) {
        return jsonResponse({ supported: true, pending: { kind: "tool-approval", request_id: "p1", prompt: "run?" } });
      }
      return jsonResponse({ id: SID, title: "Mayor", provider: "claude", state: "active", template: "mayor", session_name: SID, created_at: "x", attached: false, running: true, options: { permission_mode: "default" }, submission_capabilities: { supports_follow_up: true, supports_interrupt_now: true } });
    });

    await store.load();

    expect(store.state).toMatchObject({
      title: "Mayor",
      provider: "claude",
      turns: [{ role: "assistant", text: "hi" }],
      permissionMode: "default",
      capabilities: { supports_follow_up: true, supports_interrupt_now: true },
      pending: { request_id: "p1" },
      connection: "idle",
    });
  });

  it("still renders the transcript when the session-detail call fails", async () => {
    const { store } = makeStore((path) => {
      if (path.endsWith("/transcript")) {
        return jsonResponse({ format: "conversation", id: SID, provider: "codex", template: "mayor", turns: [{ role: "user", text: "yo" }] });
      }
      if (path.endsWith("/pending")) {
        return jsonResponse({ supported: false });
      }
      return jsonResponse({ title: "Err" }, { status: 500 });
    });

    await store.load();
    expect(store.state.turns).toEqual([{ role: "user", text: "yo" }]);
    expect(store.state.provider).toBe("codex");
    expect(store.state.connection).toBe("idle");
  });
});

describe("ConversationStore live stream", () => {
  it("applies turn / activity / pending events and clears stale pending", async () => {
    const stream = controllableStream();
    const { store } = makeStore(() => jsonResponse({}), { streamSession: () => stream.gen() });
    const states: string[] = [];
    store.onDidChange((s) => states.push(s.connection));

    store.connect();
    expect(store.state.connection).toBe("streaming");

    stream.push({ kind: "pending", pending: { kind: "tool-approval", request_id: "p1" } });
    await tick();
    expect(store.state.pending).toMatchObject({ request_id: "p1" });

    stream.push({ kind: "activity", activity: "in-turn" });
    await tick();
    expect(store.state.activity).toBe("in-turn");
    expect(store.state.pending).toBeNull(); // resuming work clears the stale prompt

    stream.push({ kind: "turn", turns: [{ role: "assistant", text: "done" }], event: {} as never });
    await tick();
    expect(store.state.turns).toEqual([{ role: "assistant", text: "done" }]);

    stream.close();
    await tick();
    expect(store.state.connection).toBe("closed");
  });

  it("marks the connection errored when the stream throws", async () => {
    // eslint-disable-next-line require-yield -- intentionally errors before emitting any event
    async function* boom(): AsyncGenerator<SessionStreamEvent, void, unknown> {
      throw new Error("stream blew up");
    }
    const { store } = makeStore(() => jsonResponse({}), { streamSession: () => boom() });
    store.connect();
    await tick();
    expect(store.state.connection).toBe("error");
    expect(store.state.lastError).toContain("stream blew up");
  });
});

describe("ConversationStore actions", () => {
  it("submit posts message + intent and toggles the sending flag", async () => {
    const { store, calls } = makeStore(() => jsonResponse({ request_id: "r1", event_cursor: "0", status: "accepted" }, { status: 202 }));
    const sendingSeen: boolean[] = [];
    store.onDidChange((s) => sendingSeen.push(s.sending));

    const res = await store.submit("hello", "follow_up");

    expect(res.ok).toBe(true);
    expect(await calls[0].clone().json()).toEqual({ message: "hello", intent: "follow_up" });
    expect(sendingSeen).toContain(true); // flipped on during the call
    expect(store.state.sending).toBe(false); // and off after
  });

  it("submit records an error on failure", async () => {
    const { store } = makeStore(() =>
      problemResponse({ type: "urn:gascity:error:busy", title: "Conflict", status: 409, detail: "busy" }, { status: 409 }),
    );
    const res = await store.submit("hi");
    expect(res.ok).toBe(false);
    expect(store.state.lastError).toBe("busy");
  });

  it("respond sends the pending request_id and optimistically clears pending", async () => {
    const stream = controllableStream();
    const { store, calls } = makeStore(
      () => jsonResponse({ id: SID, status: "accepted" }, { status: 202 }),
      { streamSession: () => stream.gen() },
    );
    store.connect();
    stream.push({ kind: "pending", pending: { kind: "tool-approval", request_id: "p7", prompt: "ok?" } });
    await tick();

    const res = await store.respond("allow", { text: "sure" });

    expect(res.ok).toBe(true);
    expect(await calls[0].clone().json()).toEqual({ action: "allow", request_id: "p7", text: "sure" });
    expect(store.state.pending).toBeNull();
  });

  it("setPermissionMode reflects the server-confirmed mode", async () => {
    const { store } = makeStore(() => jsonResponse({ id: SID, options: { permission_mode: "plan" } }));
    const res = await store.setPermissionMode("plan");
    expect(res.ok).toBe(true);
    expect(store.state.permissionMode).toBe("plan");
  });

  it("surfaces a correlated async failure via lastError", async () => {
    const { store } = makeStore(() => jsonResponse({ request_id: "r9", event_cursor: "5", status: "accepted" }, { status: 202 }), {
      awaitSubmitOutcome: async () => ({ kind: "failed", errorCode: "busy", errorMessage: "session is busy" }),
    });
    await store.submit("go");
    await tick();
    expect(store.state.lastError).toBe("session is busy");
  });
});

describe("ConversationStore.dispose", () => {
  it("stops emitting after dispose", async () => {
    const stream = controllableStream();
    const { store } = makeStore(() => jsonResponse({}), { streamSession: () => stream.gen() });
    let changes = 0;
    store.onDidChange(() => { changes += 1; });
    store.connect();
    await tick();
    const before = changes;
    store.dispose();
    stream.push({ kind: "activity", activity: "idle" });
    await tick();
    expect(changes).toBe(before); // no further emissions
  });
});
