import { describe, expect, it, vi } from "vitest";
import {
  GhostexConversationStore,
  composeGhostexTurns,
  ghostexActivityToConversation,
  type GhostexChatClient,
  type GhostexEventSubscribe,
} from "./ghostex-conversation-store.ts";
import type { ConversationState } from "./conversation-store.ts";
import type {
  GhostexEvent,
  GhostexPresentationSession,
  GhostexPresentationSnapshot,
} from "../ghostex/index.ts";
import type { ChatConversation } from "./chat-conversation.ts";
import type { ConversationStore } from "./conversation-store.ts";

// Compile-time guards: both the cockpit `ConversationStore` and this Ghostex store
// must satisfy the shared `ChatConversation` contract a chat panel binds to. If
// either drifts, this fails to type-check (caught by `npm run typecheck`). Exported
// so `noUnusedLocals` keeps them; runtime conformance is also exercised below.
type Assert<T extends true> = T;
export type CockpitStoreIsChatConversation = Assert<ConversationStore extends ChatConversation ? true : false>;
export type GhostexStoreIsChatConversation = Assert<GhostexConversationStore extends ChatConversation ? true : false>;

// ---- test helpers ----------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function presSession(overrides: Partial<GhostexPresentationSession> = {}): GhostexPresentationSession {
  return {
    sessionId: "S1",
    projectId: "P1",
    groupId: "G1",
    title: "Agent One",
    kind: "agent",
    activity: "idle",
    lifecycleState: "running",
    surface: "workspace",
    isFavorite: false,
    isPinned: false,
    sortKey: "a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function snapshot(sessions: GhostexPresentationSession[], revision = 1): GhostexPresentationSnapshot {
  return { revision, generatedAt: "2026-01-01T00:00:00Z", projects: [], groups: [], sessions };
}

function snapshotEvent(sessions: GhostexPresentationSession[], revision = 1): GhostexEvent {
  return { type: "presentationSnapshot", revision, snapshot: snapshot(sessions, revision) };
}

function upsertEvent(session: GhostexPresentationSession, revision = 2): GhostexEvent {
  return { type: "presentationDelta", revision, delta: { kind: "sessionUpserted", session } };
}

/** A fake gx client + a capturable event source. */
function harness(initialText = "") {
  const gx = {
    readSessionText: vi.fn(async () => initialText),
    sendSessionMessage: vi.fn(async () => {}),
  } satisfies GhostexChatClient;

  let captured: ((event: GhostexEvent) => void) | null = null;
  let subscribeDisposed = false;
  const subscribe: GhostexEventSubscribe = (onEvent) => {
    captured = onEvent;
    return {
      dispose: () => {
        subscribeDisposed = true;
      },
    };
  };

  return {
    gx,
    subscribe,
    emit: (event: GhostexEvent): void => captured?.(event),
    get subscribeDisposed(): boolean {
      return subscribeDisposed;
    },
  };
}

/** Subscribe to a store and collect every emitted state. */
function record(store: GhostexConversationStore): ConversationState[] {
  const states: ConversationState[] = [];
  store.onDidChange((s) => states.push(s));
  return states;
}

// ---- pure helpers ----------------------------------------------------------

describe("ghostexActivityToConversation", () => {
  it("maps working to in-turn and everything else to idle", () => {
    expect(ghostexActivityToConversation("working")).toBe("in-turn");
    expect(ghostexActivityToConversation("idle")).toBe("idle");
    expect(ghostexActivityToConversation("attention")).toBe("idle");
  });
});

describe("composeGhostexTurns", () => {
  it("returns no turns for empty input", () => {
    expect(composeGhostexTurns([], "")).toEqual([]);
  });

  it("omits the assistant turn when the buffer is only whitespace", () => {
    expect(composeGhostexTurns(["hi"], "   \n ")).toEqual([{ role: "user", text: "hi" }]);
  });

  it("renders user prompts then a single assistant buffer turn", () => {
    expect(composeGhostexTurns(["a", "b"], "agent output")).toEqual([
      { role: "user", text: "a" },
      { role: "user", text: "b" },
      { role: "assistant", text: "agent output" },
    ]);
  });
});

// ---- construction ----------------------------------------------------------

describe("GhostexConversationStore construction", () => {
  it("seeds a city-less ghostex state from deps", () => {
    const { gx, subscribe } = harness();
    const store = new GhostexConversationStore({ gx, sessionId: "S1", subscribe });
    expect(store.state).toMatchObject({
      cityName: "ghostex",
      sessionId: "S1",
      title: null,
      provider: "ghostex",
      turns: [],
      activity: "unknown",
      pending: null,
      capabilities: null,
      permissionMode: null,
      connection: "idle",
      sending: false,
      lastError: null,
    });
  });

  it("honours title/provider/label overrides", () => {
    const { gx } = harness();
    const store = new GhostexConversationStore({
      gx,
      sessionId: "S1",
      title: "My Agent",
      provider: "claude",
      label: "Ghostex · proj",
    });
    expect(store.state).toMatchObject({ title: "My Agent", provider: "claude", cityName: "Ghostex · proj" });
  });
});

// ---- load ------------------------------------------------------------------

describe("load", () => {
  it("reads the buffer into a single assistant turn and goes idle", async () => {
    const { gx, subscribe } = harness("hello from the agent");
    const store = new GhostexConversationStore({ gx, sessionId: "S1", subscribe });
    await store.load();
    expect(gx.readSessionText).toHaveBeenCalledWith({ sessionId: "S1" });
    expect(store.state.turns).toEqual([{ role: "assistant", text: "hello from the agent" }]);
    expect(store.state.connection).toBe("idle");
  });

  it("surfaces a read failure as an error state", async () => {
    const { gx } = harness();
    gx.readSessionText.mockRejectedValueOnce(new Error("gxserver unreachable"));
    const store = new GhostexConversationStore({ gx, sessionId: "S1" });
    await store.load();
    expect(store.state.connection).toBe("error");
    expect(store.state.lastError).toBe("gxserver unreachable");
  });

  it("ignores a load that resolves after dispose", async () => {
    const { gx } = harness();
    const d = deferred<string>();
    gx.readSessionText.mockReturnValueOnce(d.promise);
    const store = new GhostexConversationStore({ gx, sessionId: "S1" });
    const loading = store.load();
    store.dispose();
    d.resolve("late text");
    await loading;
    expect(store.state.turns).toEqual([]);
    expect(store.state.connection).toBe("loading");
  });

  it("stringifies a non-Error read rejection", async () => {
    const { gx } = harness();
    gx.readSessionText.mockRejectedValueOnce("plain failure");
    const store = new GhostexConversationStore({ gx, sessionId: "S1" });
    await store.load();
    expect(store.state.connection).toBe("error");
    expect(store.state.lastError).toBe("plain failure");
  });

  it("ignores a load that rejects after dispose", async () => {
    const { gx } = harness();
    const d = deferred<string>();
    gx.readSessionText.mockReturnValueOnce(d.promise);
    const store = new GhostexConversationStore({ gx, sessionId: "S1" });
    const loading = store.load();
    store.dispose();
    d.reject(new Error("late failure"));
    await loading;
    expect(store.state.connection).toBe("loading");
    expect(store.state.lastError).toBeNull();
  });
});

// ---- connect / disconnect --------------------------------------------------

describe("connect", () => {
  it("opens the event source and marks the connection streaming", () => {
    const { gx, subscribe } = harness();
    const store = new GhostexConversationStore({ gx, sessionId: "S1", subscribe });
    store.connect();
    expect(store.state.connection).toBe("streaming");
  });

  it("stays idle (no live source) when no subscribe is provided", () => {
    const { gx } = harness();
    const store = new GhostexConversationStore({ gx, sessionId: "S1" });
    store.connect();
    expect(store.state.connection).toBe("idle");
  });

  it("preserves a load error when there is no live source", async () => {
    const { gx } = harness();
    gx.readSessionText.mockRejectedValueOnce(new Error("boom"));
    const store = new GhostexConversationStore({ gx, sessionId: "S1" });
    await store.load();
    store.connect();
    expect(store.state.connection).toBe("error");
  });

  it("tears down a prior subscription when reconnecting", () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    store.connect();
    expect(h.subscribeDisposed).toBe(true);
  });
});

// ---- event application -----------------------------------------------------

describe("applyEvent", () => {
  it("updates activity, seeds the title, and re-reads on a matching snapshot", async () => {
    const h = harness("v1");
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    h.gx.readSessionText.mockResolvedValueOnce("v2");
    h.emit(snapshotEvent([presSession({ sessionId: "S1", activity: "working", title: "Live Title" })]));
    await vi.waitFor(() => expect(store.state.turns).toEqual([{ role: "assistant", text: "v2" }]));
    expect(store.state.activity).toBe("in-turn");
    expect(store.state.title).toBe("Live Title");
  });

  it("ignores a snapshot that does not contain this session", () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    h.gx.readSessionText.mockClear();
    h.emit(snapshotEvent([presSession({ sessionId: "OTHER" })]));
    expect(h.gx.readSessionText).not.toHaveBeenCalled();
    expect(store.state.activity).toBe("unknown");
  });

  it("applies a matching sessionUpserted delta", async () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    h.emit(upsertEvent(presSession({ sessionId: "S1", activity: "working" })));
    await vi.waitFor(() => expect(store.state.activity).toBe("in-turn"));
  });

  it("does not seed the title when one is already set", async () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", title: "Kept", subscribe: h.subscribe });
    store.connect();
    h.emit(upsertEvent(presSession({ sessionId: "S1", title: "New" })));
    await vi.waitFor(() => expect(h.gx.readSessionText).toHaveBeenCalled());
    expect(store.state.title).toBe("Kept");
  });

  it("ignores an unrelated sessionUpserted delta", () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    h.gx.readSessionText.mockClear();
    h.emit(upsertEvent(presSession({ sessionId: "OTHER" })));
    expect(h.gx.readSessionText).not.toHaveBeenCalled();
  });

  it("closes the connection on a matching sessionRemoved delta", () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    h.emit({ type: "presentationDelta", revision: 3, delta: { kind: "sessionRemoved", projectId: "P1", sessionId: "S1" } });
    expect(store.state.connection).toBe("closed");
  });

  it("ignores an unrelated sessionRemoved delta", () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    h.emit({ type: "presentationDelta", revision: 3, delta: { kind: "sessionRemoved", projectId: "P1", sessionId: "OTHER" } });
    expect(store.state.connection).toBe("streaming");
  });

  it("ignores a delta of another kind", () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    h.emit({ type: "presentationDelta", revision: 3, delta: { kind: "projectRemoved", projectId: "P1" } });
    expect(store.state.connection).toBe("streaming");
  });

  it("closes the connection when the server is stopping", () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    h.emit({ type: "serverStopping", serverId: "srv" });
    expect(store.state.connection).toBe("closed");
  });

  it("ignores lifecycle events it does not act on", () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    h.gx.readSessionText.mockClear();
    h.emit({ type: "eventStreamReady", serverId: "srv" });
    h.emit({ type: "serverStarted", serverId: "srv" });
    expect(h.gx.readSessionText).not.toHaveBeenCalled();
    expect(store.state.connection).toBe("streaming");
  });

  it("ignores events after dispose", () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    store.dispose();
    h.gx.readSessionText.mockClear();
    h.emit(upsertEvent(presSession({ sessionId: "S1", activity: "working" })));
    expect(h.gx.readSessionText).not.toHaveBeenCalled();
  });
});

// ---- refresh serialization -------------------------------------------------

describe("refresh", () => {
  it("does not re-emit turns when the buffer is unchanged", async () => {
    const h = harness("same");
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    await store.load();
    store.connect();
    const states = record(store);
    h.gx.readSessionText.mockResolvedValueOnce("same");
    h.emit(upsertEvent(presSession({ sessionId: "S1", activity: "idle" })));
    await vi.waitFor(() => expect(h.gx.readSessionText).toHaveBeenCalledTimes(2));
    // Only the activity patch fired; turns were not re-emitted (text unchanged).
    expect(states.every((s) => s.turns.length === 1)).toBe(true);
  });

  it("coalesces concurrent refreshes into one trailing re-read", async () => {
    const h = harness("v0");
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();

    const first = deferred<string>();
    h.gx.readSessionText.mockReturnValueOnce(first.promise);
    h.gx.readSessionText.mockResolvedValueOnce("final");

    // Two events while the first read is still in flight → one queued re-read.
    h.emit(upsertEvent(presSession({ sessionId: "S1" })));
    h.emit(upsertEvent(presSession({ sessionId: "S1" })));
    h.emit(upsertEvent(presSession({ sessionId: "S1" })));
    first.resolve("interim");
    await vi.waitFor(() => expect(store.state.turns).toEqual([{ role: "assistant", text: "final" }]));
    expect(h.gx.readSessionText).toHaveBeenCalledTimes(2);
  });

  it("ignores a refresh read that resolves after dispose", async () => {
    const h = harness("v0");
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    const d = deferred<string>();
    h.gx.readSessionText.mockReturnValueOnce(d.promise);
    h.emit(upsertEvent(presSession({ sessionId: "S1" }))); // triggers a refresh (deferred read)
    store.dispose();
    d.resolve("late");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.state.turns).toEqual([]); // the late read was never applied
  });

  it("surfaces a refresh read failure softly without dropping the stream", async () => {
    const h = harness("v0");
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    h.gx.readSessionText.mockRejectedValueOnce(new Error("read blip"));
    h.emit(upsertEvent(presSession({ sessionId: "S1" })));
    await vi.waitFor(() => expect(store.state.lastError).toBe("read blip"));
    expect(store.state.connection).toBe("streaming");
  });
});

// ---- submit ----------------------------------------------------------------

describe("submit", () => {
  it("sends the message, shows an optimistic user turn, and re-reads", async () => {
    const h = harness("");
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    h.gx.readSessionText.mockResolvedValueOnce("agent reply");
    const result = await store.submit("do the thing");
    expect(result).toEqual({ ok: true });
    expect(h.gx.sendSessionMessage).toHaveBeenCalledWith({ sessionId: "S1", text: "do the thing" });
    expect(store.state.sending).toBe(false);
    await vi.waitFor(() =>
      expect(store.state.turns).toEqual([
        { role: "user", text: "do the thing" },
        { role: "assistant", text: "agent reply" },
      ]),
    );
  });

  it("reports a send failure and clears the sending flag", async () => {
    const h = harness();
    h.gx.sendSessionMessage.mockRejectedValueOnce(new Error("send failed"));
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    const result = await store.submit("hi");
    expect(result).toEqual({ ok: false });
    expect(store.state.sending).toBe(false);
    expect(store.state.lastError).toBe("send failed");
    // The optimistic user turn is still shown.
    expect(store.state.turns).toEqual([{ role: "user", text: "hi" }]);
  });

  it("does not patch state for a send that resolves after dispose", async () => {
    const h = harness();
    const d = deferred<void>();
    h.gx.sendSessionMessage.mockReturnValueOnce(d.promise);
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    const submitting = store.submit("hi");
    store.dispose();
    d.resolve();
    await expect(submitting).resolves.toEqual({ ok: true });
    expect(store.state.sending).toBe(true); // last live patch before dispose
  });
});

// ---- inert surfaces --------------------------------------------------------

describe("unsupported surfaces", () => {
  it("respond and setPermissionMode are inert", async () => {
    const { gx, subscribe } = harness();
    const store = new GhostexConversationStore({ gx, sessionId: "S1", subscribe });
    expect(await store.respond()).toEqual({ ok: false });
    expect(await store.setPermissionMode()).toEqual({ ok: false });
  });
});

// ---- lifecycle -------------------------------------------------------------

describe("start / dispose", () => {
  it("start loads then connects", async () => {
    const h = harness("buffer");
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    await store.start();
    expect(store.state.turns).toEqual([{ role: "assistant", text: "buffer" }]);
    expect(store.state.connection).toBe("streaming");
  });

  it("dispose tears down the subscription and is idempotent", () => {
    const h = harness();
    const store = new GhostexConversationStore({ gx: h.gx, sessionId: "S1", subscribe: h.subscribe });
    store.connect();
    store.dispose();
    store.dispose();
    expect(h.subscribeDisposed).toBe(true);
  });

  it("does not emit state after dispose", async () => {
    const { gx, subscribe } = harness();
    const store = new GhostexConversationStore({ gx, sessionId: "S1", subscribe });
    const states = record(store);
    store.dispose();
    await store.load();
    expect(states).toEqual([]);
  });
});
