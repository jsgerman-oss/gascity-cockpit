import { describe, expect, it } from "vitest";
import {
  ghostexSessionPickLabel,
  isAgentSession,
  rankGhostexAgentSessions,
} from "./ghostex-session-picker.ts";
import type { GhostexSession } from "../ghostex/index.ts";

function session(overrides: Partial<GhostexSession> = {}): GhostexSession {
  return {
    sessionId: "S1",
    projectId: "P1",
    globalRef: "S1:P1:G1",
    kind: "agent",
    title: "Agent",
    lifecycleState: "running",
    surface: "workspace",
    isFavorite: false,
    isPinned: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("isAgentSession", () => {
  it("accepts agent sessions and rejects terminal sessions", () => {
    expect(isAgentSession(session({ kind: "agent" }))).toBe(true);
    expect(isAgentSession(session({ kind: "terminal" }))).toBe(false);
  });
});

describe("rankGhostexAgentSessions", () => {
  it("drops non-agent sessions", () => {
    const ranked = rankGhostexAgentSessions([
      session({ sessionId: "a", kind: "terminal" }),
      session({ sessionId: "b", kind: "agent" }),
    ]);
    expect(ranked.map((s) => s.sessionId)).toEqual(["b"]);
  });

  it("floats running sessions ahead of non-running ones", () => {
    const ranked = rankGhostexAgentSessions([
      session({ sessionId: "asleep", lifecycleState: "sleeping" }),
      session({ sessionId: "live", lifecycleState: "running" }),
    ]);
    expect(ranked.map((s) => s.sessionId)).toEqual(["live", "asleep"]);
  });

  it("orders running sessions by recency, newest first", () => {
    const ranked = rankGhostexAgentSessions([
      session({ sessionId: "older", lastActiveAt: "2026-01-01T00:00:00Z" }),
      session({ sessionId: "newer", lastActiveAt: "2026-02-01T00:00:00Z" }),
    ]);
    expect(ranked.map((s) => s.sessionId)).toEqual(["newer", "older"]);
  });

  it("falls back to updatedAt when lastActiveAt is absent, then to title", () => {
    const ranked = rankGhostexAgentSessions([
      session({ sessionId: "z", title: "Zeta", updatedAt: "2026-03-01T00:00:00Z" }),
      session({ sessionId: "a", title: "Alpha", updatedAt: "2026-03-01T00:00:00Z" }),
    ]);
    // Same timestamp → alphabetical by title.
    expect(ranked.map((s) => s.title)).toEqual(["Alpha", "Zeta"]);
  });

  it("treats an unparseable timestamp as the epoch", () => {
    const ranked = rankGhostexAgentSessions([
      session({ sessionId: "bad", lastActiveAt: "not-a-date" }),
      session({ sessionId: "good", lastActiveAt: "2026-01-01T00:00:00Z" }),
    ]);
    expect(ranked.map((s) => s.sessionId)).toEqual(["good", "bad"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      session({ sessionId: "a", lifecycleState: "sleeping" }),
      session({ sessionId: "b", lifecycleState: "running" }),
    ];
    const copy = [...input];
    rankGhostexAgentSessions(input);
    expect(input).toEqual(copy);
  });
});

describe("ghostexSessionPickLabel", () => {
  it("builds a label from title, lifecycle, and agent id", () => {
    expect(
      ghostexSessionPickLabel(session({ sessionId: "S9", title: "Builder", lifecycleState: "running", agentId: "claude" })),
    ).toEqual({ label: "Builder", description: "running · claude", detail: "S9", id: "S9" });
  });

  it("falls back to the session id for the label and omits a missing agent id", () => {
    expect(ghostexSessionPickLabel(session({ sessionId: "S9", title: "", lifecycleState: "stopped", agentId: undefined }))).toEqual(
      { label: "S9", description: "stopped", detail: "S9", id: "S9" },
    );
  });
});
