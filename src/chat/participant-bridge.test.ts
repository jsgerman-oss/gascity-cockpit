import { describe, expect, it } from "vitest";
import type { AsyncAccepted, ApiResult, ConversationTurn, SubmitOutcome } from "../api/index.ts";
import { awaitSubmitOutcome as defaultAwaitSubmitOutcome } from "../api/index.ts";
import type { Disposable } from "../discovery/index.ts";
import type { ConversationState } from "./conversation-store.ts";
import {
  AssistantDelta,
  assistantTextSince,
  describePending,
  driveTurn,
  type ParticipantStore,
} from "./participant-bridge.ts";

const ENDPOINT = { baseUrl: "http://api.test", token: null };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function convState(partial: Partial<ConversationState> = {}): ConversationState {
  return {
    cityName: "blackrim-hq",
    sessionId: "mayor-1",
    title: null,
    provider: null,
    turns: [],
    activity: "unknown",
    pending: null,
    capabilities: null,
    permissionMode: null,
    connection: "idle",
    sending: false,
    lastError: null,
    ...partial,
  };
}

/** A hand-driven {@link ParticipantStore}: the test fires state changes via `set`. */
class FakeStore implements ParticipantStore {
  state: ConversationState;
  submitResult: ApiResult<AsyncAccepted> = {
    ok: true,
    data: { request_id: "r1", event_cursor: "5", status: "accepted" },
  };
  startError: Error | null = null;
  private readonly listeners = new Set<(state: ConversationState) => void>();

  constructor(initial: Partial<ConversationState> = {}) {
    this.state = convState(initial);
  }

  onDidChange = (listener: (state: ConversationState) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  async start(): Promise<void> {
    if (this.startError) {
      throw this.startError;
    }
  }

  async submit(): Promise<ApiResult<AsyncAccepted>> {
    return this.submitResult;
  }

  /** Patch state and notify subscribers, the way the live stream would. */
  set(patch: Partial<ConversationState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) {
      listener(this.state);
    }
  }
}

function fakeSink() {
  const markdown: string[] = [];
  const progress: string[] = [];
  return {
    sink: { markdown: (t: string) => markdown.push(t), progress: (t: string) => progress.push(t) },
    markdown,
    progress,
  };
}

/** An outcome correlation that never settles — used when activity drives completion. */
const neverOutcome: typeof defaultAwaitSubmitOutcome = () => new Promise<SubmitOutcome>(() => {});

/** A controllable outcome correlation — the test resolves it to drive the backstop. */
function deferredOutcome() {
  let resolve!: (outcome: SubmitOutcome) => void;
  const fn: typeof defaultAwaitSubmitOutcome = () =>
    new Promise<SubmitOutcome>((res) => {
      resolve = res;
    });
  return { fn, resolve: (outcome: SubmitOutcome) => resolve(outcome) };
}

const turns = (...entries: [role: string, text: string][]): ConversationTurn[] =>
  entries.map(([role, text]) => ({ role, text }));

describe("assistantTextSince", () => {
  it("joins non-user turns from the baseline, skipping the echoed prompt", () => {
    const snapshot = turns(
      ["user", "old"],
      ["assistant", "old reply"],
      ["user", "hi"], // the just-submitted prompt echoes back
      ["assistant", "Hello"],
      ["assistant", "and more"],
    );
    expect(assistantTextSince(snapshot, 2)).toBe("Hello\n\nand more");
  });

  it("returns empty when only the user prompt has landed", () => {
    expect(assistantTextSince(turns(["user", "hi"]), 0)).toBe("");
  });
});

describe("AssistantDelta", () => {
  it("emits only newly-appended assistant text", () => {
    const delta = new AssistantDelta(1);
    expect(delta.next(turns(["user", "hi"]))).toBe("");
    expect(delta.next(turns(["user", "hi"], ["assistant", "Hel"]))).toBe("Hel");
    expect(delta.next(turns(["user", "hi"], ["assistant", "Hello"]))).toBe("lo");
    expect(delta.next(turns(["user", "hi"], ["assistant", "Hello"]))).toBe("");
  });

  it("re-syncs without duplicating on a non-append rewrite", () => {
    const delta = new AssistantDelta(0);
    expect(delta.next(turns(["assistant", "abc"]))).toBe("abc");
    // A shorter/divergent snapshot must not re-print already-shown text.
    expect(delta.next(turns(["assistant", "xy"]))).toBe("");
  });
});

describe("describePending", () => {
  it("renders the prompt, kind, and options", () => {
    const md = describePending({
      kind: "tool-approval",
      request_id: "p1",
      prompt: "Run the tests?",
      options: ["approve", "deny"],
    });
    expect(md).toContain("tool approval");
    expect(md).toContain("Run the tests?");
    expect(md).toContain("`approve`");
    expect(md).toContain("`deny`");
  });

  it("falls back to a generic line when kind / prompt / options are absent", () => {
    const md = describePending({ kind: "", request_id: "p2" });
    expect(md).toContain("input"); // the default kind word
    expect(md).not.toContain("Options:");
    // No prompt body and no options list — just the single header line.
    expect(md).toBe("**The Mayor needs your input** — input.");
  });

  it("omits the options line when the prompt is present but options are empty", () => {
    const md = describePending({ kind: "prompt-for-input", request_id: "p3", prompt: "Name?", options: [] });
    expect(md).toContain("Name?");
    expect(md).not.toContain("Options:");
  });
});

describe("driveTurn", () => {
  it("streams assistant deltas and completes on an in-turn → idle transition", async () => {
    const store = new FakeStore();
    const { sink, markdown, progress } = fakeSink();
    const result = driveTurn({
      store,
      endpoint: ENDPOINT,
      prompt: "hi",
      signal: new AbortController().signal,
      sink,
      awaitSubmitOutcome: neverOutcome,
    });
    await tick();

    store.set({ activity: "in-turn", turns: turns(["user", "hi"], ["assistant", "Hello"]) });
    store.set({ turns: turns(["user", "hi"], ["assistant", "Hello, operator."]) });
    store.set({ activity: "idle" });

    expect(await result).toEqual({ status: "completed" });
    expect(markdown.join("")).toBe("Hello, operator.");
    expect(progress).toContain("The Mayor is working…");
  });

  it("backstops completion on the city-event outcome when no activity arrives", async () => {
    const store = new FakeStore();
    const { sink } = fakeSink();
    const outcome = deferredOutcome();
    const result = driveTurn({
      store,
      endpoint: ENDPOINT,
      prompt: "hi",
      signal: new AbortController().signal,
      sink,
      awaitSubmitOutcome: outcome.fn,
    });
    await tick();

    outcome.resolve({ kind: "succeeded", type: "request.result.session.submit" });
    expect(await result).toEqual({ status: "completed" });
  });

  it("surfaces a failed outcome as an error", async () => {
    const store = new FakeStore();
    const { sink } = fakeSink();
    const outcome = deferredOutcome();
    const result = driveTurn({
      store,
      endpoint: ENDPOINT,
      prompt: "hi",
      signal: new AbortController().signal,
      sink,
      awaitSubmitOutcome: outcome.fn,
    });
    await tick();

    outcome.resolve({ kind: "failed", errorCode: "boom", errorMessage: "server failed" });
    expect(await result).toEqual({ status: "error", message: "server failed" });
  });

  it("stops the turn when a pending interaction appears", async () => {
    const store = new FakeStore();
    const { sink } = fakeSink();
    const result = driveTurn({
      store,
      endpoint: ENDPOINT,
      prompt: "deploy",
      signal: new AbortController().signal,
      sink,
      awaitSubmitOutcome: neverOutcome,
    });
    await tick();

    const pending = { kind: "tool-approval", request_id: "p1", prompt: "Approve deploy?" };
    store.set({ pending });
    expect(await result).toEqual({ status: "pending", pending });
  });

  it("surfaces a store connection error as a turn error", async () => {
    const store = new FakeStore();
    const { sink } = fakeSink();
    const result = driveTurn({
      store,
      endpoint: ENDPOINT,
      prompt: "hi",
      signal: new AbortController().signal,
      sink,
      awaitSubmitOutcome: neverOutcome,
    });
    await tick();

    store.set({ connection: "error", lastError: "stream blew up" });
    expect(await result).toEqual({ status: "error", message: "stream blew up" });
  });

  it("completes when the per-session stream closes without an idle transition", async () => {
    const store = new FakeStore();
    const { sink } = fakeSink();
    const result = driveTurn({
      store,
      endpoint: ENDPOINT,
      prompt: "hi",
      signal: new AbortController().signal,
      sink,
      awaitSubmitOutcome: neverOutcome,
    });
    await tick();

    store.set({ connection: "closed" });
    expect(await result).toEqual({ status: "completed" });
  });

  it("passes a non-default intent through and tolerates a submit without an event cursor", async () => {
    const store = new FakeStore();
    // An empty event_cursor is falsy, so the correlation params omit it (the other branch).
    store.submitResult = { ok: true, data: { request_id: "r2", event_cursor: "", status: "accepted" } };
    const { sink } = fakeSink();
    const outcome = deferredOutcome();
    const result = driveTurn({
      store,
      endpoint: ENDPOINT,
      prompt: "hi",
      intent: "follow_up",
      signal: new AbortController().signal,
      sink,
      awaitSubmitOutcome: outcome.fn,
    });
    await tick();

    outcome.resolve({ kind: "succeeded", type: "request.result.session.submit" });
    expect(await result).toEqual({ status: "completed" });
  });

  it("returns an error when the submit is rejected", async () => {
    const store = new FakeStore();
    store.submitResult = { ok: false, error: { status: 500, title: "Server error", detail: "no capacity" } };
    const { sink } = fakeSink();
    const result = await driveTurn({
      store,
      endpoint: ENDPOINT,
      prompt: "hi",
      signal: new AbortController().signal,
      sink,
      awaitSubmitOutcome: neverOutcome,
    });
    expect(result).toEqual({ status: "error", message: "no capacity" });
  });

  it("resolves cancelled when the request token aborts mid-turn", async () => {
    const store = new FakeStore();
    const { sink } = fakeSink();
    const controller = new AbortController();
    const result = driveTurn({
      store,
      endpoint: ENDPOINT,
      prompt: "hi",
      signal: controller.signal,
      sink,
      awaitSubmitOutcome: neverOutcome,
    });
    await tick();

    controller.abort();
    expect(await result).toEqual({ status: "cancelled" });
  });

  it("does not start when the token is already aborted", async () => {
    const store = new FakeStore();
    const { sink } = fakeSink();
    const controller = new AbortController();
    controller.abort();
    const result = await driveTurn({
      store,
      endpoint: ENDPOINT,
      prompt: "hi",
      signal: controller.signal,
      sink,
      awaitSubmitOutcome: neverOutcome,
    });
    expect(result).toEqual({ status: "cancelled" });
  });
});
