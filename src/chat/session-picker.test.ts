import { describe, expect, it } from "vitest";
import type { SessionDetail } from "../api/index.ts";
import { isLikelyMayor, rankSessionsForChat, sessionPickLabel } from "./session-picker.ts";

function session(partial: Partial<SessionDetail>): SessionDetail {
  return {
    id: "id",
    template: "",
    state: "active",
    title: "Session",
    provider: "claude",
    session_name: "sess",
    created_at: "2026-06-05T00:00:00Z",
    attached: false,
    running: true,
    ...partial,
  } as SessionDetail;
}

describe("isLikelyMayor", () => {
  it("matches the Mayor in template, alias, display name, or title", () => {
    expect(isLikelyMayor(session({ template: "gastown.mayor" }))).toBe(true);
    expect(isLikelyMayor(session({ title: "The Mayor", template: "x" }))).toBe(true);
    expect(isLikelyMayor(session({ display_name: "Mayor console", template: "x", title: "x" }))).toBe(true);
    expect(isLikelyMayor(session({ template: "gastown.polecat", title: "worker" }))).toBe(false);
  });
});

describe("rankSessionsForChat", () => {
  it("orders Mayor first, then active sessions, then alphabetically", () => {
    const input = [
      session({ id: "p-idle", template: "gastown.polecat", title: "zeta", state: "closed" }),
      session({ id: "p-active", template: "gastown.polecat", title: "beta", state: "active" }),
      session({ id: "mayor", template: "gastown.mayor", title: "Mayor", state: "closed" }),
      session({ id: "p-active2", template: "gastown.polecat", title: "alpha", state: "active" }),
    ];
    const ranked = rankSessionsForChat(input).map((s) => s.id);
    expect(ranked[0]).toBe("mayor"); // Mayor first even though closed
    expect(ranked.slice(1)).toEqual(["p-active2", "p-active", "p-idle"]); // active (alpha,beta) then idle
  });

  it("does not mutate the input array", () => {
    const input = [session({ id: "a" }), session({ id: "b" })];
    const order = input.map((s) => s.id);
    rankSessionsForChat(input);
    expect(input.map((s) => s.id)).toEqual(order);
  });
});

describe("sessionPickLabel", () => {
  it("builds a label, description, and carries the id", () => {
    const label = sessionPickLabel(session({ id: "s1", display_name: "Mayor", state: "active", template: "gastown.mayor" }));
    expect(label).toEqual({ label: "Mayor", description: "active · gastown.mayor", detail: "s1", id: "s1" });
  });

  it("falls back to title then session_name and omits an empty template", () => {
    const label = sessionPickLabel(session({ id: "s2", title: "Worker", template: "", session_name: "sess-2", display_name: undefined }));
    expect(label.label).toBe("Worker");
    expect(label.description).toBe("active");
  });
});
