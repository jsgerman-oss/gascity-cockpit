import { describe, expect, it } from "vitest";
import type { ConnectionState } from "../discovery/types.ts";
import {
  connectivityOf,
  resolvePaneState,
  type Connectivity,
  type PaneInputs,
} from "./pane-state.ts";
import { CONNECTING, RECONNECTING } from "./view-state.ts";

// A pane with no rows, no error, not loading, on a live link — the baseline each
// test perturbs one axis of.
function inputs(overrides: Partial<PaneInputs> = {}): PaneInputs {
  return {
    connectivity: "live",
    loading: false,
    hasContent: false,
    resource: "beads",
    empty: { label: "No beads" },
    ...overrides,
  };
}

describe("connectivityOf", () => {
  it("treats only `connected` as live", () => {
    expect(connectivityOf("connected")).toBe("live");
  });

  it("treats both loss states — reconnecting and the gave-up `unavailable` — as lost", () => {
    expect(connectivityOf("reconnecting")).toBe("lost");
    expect(connectivityOf("unavailable")).toBe("lost");
  });

  it("treats every coming-up state — including up-but-not-ready `degraded` — as starting", () => {
    expect(connectivityOf("idle")).toBe("starting");
    expect(connectivityOf("discovering")).toBe("starting");
    expect(connectivityOf("connecting")).toBe("starting");
    expect(connectivityOf("degraded")).toBe("starting");
  });

  it("maps every ConnectionState to exactly one connectivity (total function)", () => {
    const all: ConnectionState[] = [
      "idle",
      "discovering",
      "connecting",
      "connected",
      "degraded",
      "reconnecting",
      "unavailable",
    ];
    const valid: Connectivity[] = ["starting", "live", "lost"];
    for (const state of all) expect(valid).toContain(connectivityOf(state));
  });
});

describe("resolvePaneState — lost link", () => {
  it("surfaces reconnecting, replacing absent content", () => {
    const state = resolvePaneState(inputs({ connectivity: "lost", hasContent: false }));
    expect(state).toEqual({
      kind: "notice",
      notice: { tone: "reconnecting", label: RECONNECTING, icon: "sync~spin", iconColor: "list.warningForeground" },
      overlay: false,
    });
  });

  it("overlays reconnecting on retained (now-stale) content rather than blanking the pane", () => {
    const state = resolvePaneState(inputs({ connectivity: "lost", hasContent: true }));
    expect(state.kind).toBe("notice");
    if (state.kind !== "notice") throw new Error("unreachable");
    expect(state.overlay).toBe(true);
    expect(state.notice.tone).toBe("reconnecting");
  });

  it("folds the drop's cause into the reconnecting detail (the probe + backoff)", () => {
    const state = resolvePaneState(
      inputs({ connectivity: "lost", error: "health probe failed (http://127.0.0.1:8372) — retrying in 1s (attempt 3)" }),
    );
    if (state.kind !== "notice") throw new Error("unreachable");
    expect(state.notice.detail).toContain("attempt 3");
  });

  it("lets the lost link win over a pane-local fetch error — the error is just the drop's symptom", () => {
    // Same fetch error, two links: live → it's a real load failure; lost → it's
    // subsumed by the reconnecting row. The lost link must win.
    const live = resolvePaneState(inputs({ connectivity: "live", error: "HTTP 500" }));
    const lost = resolvePaneState(inputs({ connectivity: "lost", error: "HTTP 500" }));
    if (live.kind !== "notice" || lost.kind !== "notice") throw new Error("unreachable");
    expect(live.notice.tone).toBe("error");
    expect(lost.notice.tone).toBe("reconnecting");
  });
});

describe("resolvePaneState — link coming up", () => {
  it("shows the shared connecting row when there is nothing yet", () => {
    const state = resolvePaneState(inputs({ connectivity: "starting", hasContent: false }));
    expect(state).toEqual({
      kind: "notice",
      notice: { tone: "loading", label: CONNECTING, icon: "loading~spin" },
      overlay: false,
    });
  });

  it("keeps prior rows while the link re-establishes (no spinner flash over content)", () => {
    const state = resolvePaneState(inputs({ connectivity: "starting", hasContent: true }));
    expect(state).toEqual({ kind: "ready" });
  });
});

describe("resolvePaneState — live link", () => {
  it("renders content whenever the pane has rows", () => {
    expect(resolvePaneState(inputs({ hasContent: true }))).toEqual({ kind: "ready" });
  });

  it("keeps rendering rows even through a fresh fetch error or an in-flight reload", () => {
    expect(resolvePaneState(inputs({ hasContent: true, error: "HTTP 500" }))).toEqual({ kind: "ready" });
    expect(resolvePaneState(inputs({ hasContent: true, loading: true }))).toEqual({ kind: "ready" });
  });

  it("words a fetch failure with no rows the same as every other pane, cause in the detail", () => {
    const state = resolvePaneState(inputs({ resource: "the fleet", error: "HTTP 503" }));
    if (state.kind !== "notice") throw new Error("unreachable");
    expect(state.notice).toEqual({
      tone: "error",
      label: "Couldn't load the fleet.",
      detail: "HTTP 503",
      icon: "error",
      iconColor: "list.errorForeground",
    });
  });

  it("shows the connecting row for a first load still in flight (no rows, no error)", () => {
    const state = resolvePaneState(inputs({ loading: true }));
    if (state.kind !== "notice") throw new Error("unreachable");
    expect(state.notice.tone).toBe("loading");
    expect(state.notice.label).toBe(CONNECTING);
  });

  it("ranks a fetch error ahead of a still-in-flight reload when both are set", () => {
    const state = resolvePaneState(inputs({ loading: true, error: "HTTP 500" }));
    if (state.kind !== "notice") throw new Error("unreachable");
    expect(state.notice.tone).toBe("error");
  });

  it("falls through to the pane's own empty copy when the fetch succeeded with nothing", () => {
    const state = resolvePaneState(
      inputs({ empty: { label: "Merge queue is empty", detail: "Nothing waiting.", icon: "check-all" } }),
    );
    if (state.kind !== "notice") throw new Error("unreachable");
    expect(state.notice).toEqual({
      tone: "empty",
      label: "Merge queue is empty",
      detail: "Nothing waiting.",
      icon: "check-all",
    });
  });

  it("treats an empty-string error as no error (falls through to empty)", () => {
    const state = resolvePaneState(inputs({ error: "" }));
    if (state.kind !== "notice") throw new Error("unreachable");
    expect(state.notice.tone).toBe("empty");
  });
});
