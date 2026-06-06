import { describe, expect, it } from "vitest";
import { createCockpitClient } from "../api/client";
import type { SessionStreamEvent, SubmitOutcome } from "../api/index.ts";
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

  it("aborts outstanding outcome correlations on dispose and is idempotent", async () => {
    const { store } = makeStore(
      () => jsonResponse({ request_id: "r1", event_cursor: "1", status: "accepted" }, { status: 202 }),
      { awaitSubmitOutcome: () => new Promise<SubmitOutcome>(() => {}) }, // never settles
    );
    await store.submit("go"); // registers an outcome controller
    store.dispose(); // aborts and clears it
    store.dispose(); // second call returns early — no double-teardown
    expect(store.state.connection).toBe("idle");
  });
});

describe("ConversationStore.load — partial and total failure", () => {
  it("marks the connection errored when both session and transcript fail", async () => {
    const { store } = makeStore((path) => {
      if (path.endsWith("/transcript")) return problemResponse({ type: "urn:test:down", title: "Transcript", status: 503, detail: "stream down" }, { status: 503 });
      if (path.endsWith("/pending")) return jsonResponse({ supported: false });
      return problemResponse({ type: "urn:test:down", title: "Session", status: 503 }, { status: 503 });
    });
    await store.load();
    expect(store.state.connection).toBe("error");
    expect(store.state.lastError).toBe("stream down");
  });

  it("tolerates a failing pending probe and still renders", async () => {
    const { store } = makeStore((path) => {
      if (path.endsWith("/transcript")) return jsonResponse({ format: "conversation", id: SID, turns: [] });
      if (path.endsWith("/pending")) return problemResponse({ type: "urn:test:no-pending", title: "no pending", status: 500 }, { status: 500 });
      return jsonResponse({ id: SID, title: "Mayor" });
    });
    await store.load();
    expect(store.state.pending).toBeNull();
    expect(store.state.connection).toBe("idle");
  });
});

describe("ConversationStore stream — activity and ignored events", () => {
  it("normalizes idle / unknown activity and ignores heartbeats", async () => {
    const stream = controllableStream();
    const { store } = makeStore(() => jsonResponse({}), { streamSession: () => stream.gen() });
    store.connect();

    stream.push({ kind: "activity", activity: "idle" });
    await tick();
    expect(store.state.activity).toBe("idle");

    stream.push({ kind: "activity", activity: "weird" as never });
    await tick();
    expect(store.state.activity).toBe("unknown");

    stream.push({ kind: "heartbeat" } as never); // an ignored event kind
    await tick();
    expect(store.state.activity).toBe("unknown"); // unchanged

    stream.close();
    await tick();
  });

  it("stops applying events once the stream is disconnected", async () => {
    const stream = controllableStream();
    const { store } = makeStore(() => jsonResponse({}), { streamSession: () => stream.gen() });
    store.connect();
    stream.push({ kind: "activity", activity: "in-turn" });
    await tick();

    store.disconnect(); // aborts the stream signal
    stream.push({ kind: "turn", turns: [{ role: "assistant", text: "late" }], event: {} as never });
    await tick();
    expect(store.state.turns).toEqual([]); // the post-abort event is dropped
  });
});

describe("ConversationStore.sendMessage", () => {
  it("posts the message and toggles the sending flag", async () => {
    const { store } = makeStore(() => jsonResponse({ request_id: "r1", event_cursor: "0", status: "accepted" }, { status: 202 }));
    const res = await store.sendMessage("ping");
    expect(res.ok).toBe(true);
    expect(store.state.sending).toBe(false);
  });

  it("records an error when the send fails", async () => {
    const { store } = makeStore(() => problemResponse({ type: "urn:test:busy", title: "Busy", status: 409, detail: "later" }, { status: 409 }));
    const res = await store.sendMessage("ping");
    expect(res.ok).toBe(false);
    expect(store.state.lastError).toBe("later");
  });
});

describe("ConversationStore.respond — variants", () => {
  it("responds with no pending request id and forwards metadata", async () => {
    const { store, calls } = makeStore(() => jsonResponse({ id: SID, status: "accepted" }, { status: 202 }));
    const res = await store.respond("allow", { metadata: { reason: "ok" } });
    expect(res.ok).toBe(true);
    expect(await calls[0].clone().json()).toEqual({ action: "allow", metadata: { reason: "ok" } });
    expect(store.state.pending).toBeNull();
  });

  it("records an error when respond fails", async () => {
    const { store } = makeStore(() => problemResponse({ type: "urn:test:gone", title: "Gone", status: 410, detail: "expired" }, { status: 410 }));
    const res = await store.respond("allow");
    expect(res.ok).toBe(false);
    expect(store.state.lastError).toBe("expired");
  });
});

describe("ConversationStore.setPermissionMode — variants", () => {
  it("falls back to the requested mode when the server omits one", async () => {
    const { store } = makeStore(() => jsonResponse({ id: SID })); // no options.permission_mode
    const res = await store.setPermissionMode("acceptEdits");
    expect(res.ok).toBe(true);
    expect(store.state.permissionMode).toBe("acceptEdits");
  });

  it("records an error when the mode change fails", async () => {
    const { store } = makeStore(() => problemResponse({ type: "urn:test:bad-mode", title: "No", status: 400, detail: "bad mode" }, { status: 400 }));
    const res = await store.setPermissionMode("plan");
    expect(res.ok).toBe(false);
    expect(store.state.lastError).toBe("bad mode");
  });
});

describe("ConversationStore.submit — outcome correlation", () => {
  it("leaves lastError clear when the correlated outcome succeeds (no event cursor)", async () => {
    const { store } = makeStore(
      () => jsonResponse({ request_id: "r1", status: "accepted" }, { status: 202 }), // no event_cursor
      { awaitSubmitOutcome: async () => ({ kind: "succeeded", type: "request.result.session.submit" }) },
    );
    await store.submit("go");
    await tick();
    expect(store.state.lastError).toBeNull();
  });
});

describe("ConversationStore — default seams + start()", () => {
  it("uses the real stream/outcome defaults when those seams are omitted", () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const client = createCockpitClient({ baseUrl: ENDPOINT.baseUrl, fetch });
    const store = new ConversationStore({ client, endpoint: ENDPOINT, cityName: CITY, sessionId: SID });
    expect(store.state.connection).toBe("idle");
    store.dispose();
  });

  it("start() loads a snapshot then opens the live stream", async () => {
    const stream = controllableStream();
    const { store } = makeStore(() => jsonResponse({ id: SID, title: "Mayor" }), { streamSession: () => stream.gen() });
    await store.start();
    expect(store.state.connection).toBe("streaming");
    stream.close();
    await tick();
  });
});
