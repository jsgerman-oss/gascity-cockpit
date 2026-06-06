import { describe, expect, it } from "vitest";
import type { ConversationState } from "./conversation-store.ts";
import { isWebviewToHost, noticeViewState, toViewState } from "./protocol.ts";

const baseState: ConversationState = {
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
};

describe("toViewState", () => {
  it("falls back to the session id for the title and flattens defaults", () => {
    const view = toViewState(baseState);
    expect(view.title).toBe("mayor-1");
    expect(view.capabilities).toEqual({ followUp: false, interruptNow: false });
    expect(view.pending).toBeNull();
    expect(view.error).toBeNull();
  });

  it("maps turns and drops absent timestamps", () => {
    const view = toViewState({
      ...baseState,
      turns: [
        { role: "user", text: "hi", timestamp: "2026-06-05T00:00:00Z" },
        { role: "assistant", text: "yo" },
      ],
    });
    expect(view.turns).toEqual([
      { role: "user", text: "hi", timestamp: "2026-06-05T00:00:00Z" },
      { role: "assistant", text: "yo" },
    ]);
    expect("timestamp" in view.turns[1]).toBe(false);
  });

  it("flattens pending and reads capabilities + error", () => {
    const view = toViewState({
      ...baseState,
      title: "Mayor",
      pending: { kind: "tool-approval", request_id: "p1", prompt: "run it?", options: ["allow", "deny"] },
      capabilities: { supports_follow_up: true, supports_interrupt_now: false },
      lastError: "boom",
    });
    expect(view.title).toBe("Mayor");
    expect(view.pending).toEqual({ kind: "tool-approval", prompt: "run it?", options: ["allow", "deny"], requestId: "p1" });
    expect(view.capabilities).toEqual({ followUp: true, interruptNow: false });
    expect(view.error).toBe("boom");
  });

  it("defaults a pending prompt/options to empty when absent", () => {
    const view = toViewState({ ...baseState, pending: { kind: "prompt-for-input", request_id: "p2" } });
    expect(view.pending).toEqual({ kind: "prompt-for-input", prompt: "", options: [], requestId: "p2" });
  });

  it("never overlays a notice on a live conversation", () => {
    expect(toViewState(baseState).notice).toBeNull();
  });
});

describe("noticeViewState", () => {
  it("carries the notice, shows no conversation, and disables nothing it can't", () => {
    const view = noticeViewState(
      { tone: "loading", label: "Connecting to supervisor…" },
      { cityName: "blackrim-hq" },
    );
    expect(view.notice).toEqual({ tone: "loading", label: "Connecting to supervisor…" });
    expect(view.turns).toEqual([]);
    expect(view.pending).toBeNull();
    expect(view.cityName).toBe("blackrim-hq");
    expect(view.connection).toBe("idle");
  });

  it("marks an error-tone notice's connection as error", () => {
    const view = noticeViewState({ tone: "error", label: "Couldn't load the Mayor chat.", detail: "down" });
    expect(view.connection).toBe("error");
    expect(view.notice?.detail).toBe("down");
  });

  it("falls back to a Mayor title and empty ref fields", () => {
    const view = noticeViewState({ tone: "empty", label: "No Mayor session yet" });
    expect(view.title).toBe("Mayor");
    expect(view.cityName).toBe("");
    expect(view.sessionId).toBe("");
  });
});

describe("isWebviewToHost", () => {
  it("accepts well-formed messages", () => {
    expect(isWebviewToHost({ type: "ready" })).toBe(true);
    expect(isWebviewToHost({ type: "reconnect" })).toBe(true);
    expect(isWebviewToHost({ type: "submit", message: "hi", intent: "default" })).toBe(true);
    expect(isWebviewToHost({ type: "submit", message: "hi", intent: "interrupt_now" })).toBe(true);
    expect(isWebviewToHost({ type: "respond", action: "allow" })).toBe(true);
    expect(isWebviewToHost({ type: "respond", action: "allow", text: "yes" })).toBe(true);
    expect(isWebviewToHost({ type: "setPermissionMode", mode: "plan" })).toBe(true);
  });

  it("rejects malformed or unknown messages", () => {
    expect(isWebviewToHost(null)).toBe(false);
    expect(isWebviewToHost("ready")).toBe(false);
    expect(isWebviewToHost({ type: "nope" })).toBe(false);
    expect(isWebviewToHost({ type: "submit", message: "hi", intent: "sideways" })).toBe(false);
    expect(isWebviewToHost({ type: "submit", message: 42, intent: "default" })).toBe(false);
    expect(isWebviewToHost({ type: "respond" })).toBe(false);
    expect(isWebviewToHost({ type: "respond", action: "allow", text: 7 })).toBe(false);
    expect(isWebviewToHost({ type: "setPermissionMode" })).toBe(false);
  });
});
