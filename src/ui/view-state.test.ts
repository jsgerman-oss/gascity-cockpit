import { describe, expect, it } from "vitest";
import {
  CONNECTING,
  RECONNECTING,
  STATE_LOOK,
  emptyNotice,
  errorNotice,
  loadingNotice,
  reconnectingNotice,
} from "./view-state.ts";

describe("STATE_LOOK", () => {
  it("spins while loading and carries no colour", () => {
    expect(STATE_LOOK.loading).toEqual({ icon: "loading~spin" });
  });

  it("wears the theme error colour for the error tone, a neutral dot for empty", () => {
    expect(STATE_LOOK.error).toEqual({ icon: "error", iconColor: "list.errorForeground" });
    expect(STATE_LOOK.empty).toEqual({ icon: "info" });
  });

  it("spins the sync glyph in the warning colour while reconnecting — distinct from loading and error", () => {
    expect(STATE_LOOK.reconnecting).toEqual({ icon: "sync~spin", iconColor: "list.warningForeground" });
    // The two spinners must not be confusable: a neutral first-load spinner vs a
    // warning-tinted reconnect, so an operator can tell "still connecting" from
    // "lost the link" at a glance.
    expect(STATE_LOOK.reconnecting.icon).not.toBe(STATE_LOOK.loading.icon);
    expect(STATE_LOOK.reconnecting.iconColor).not.toBe(STATE_LOOK.error.iconColor);
  });
});

describe("loadingNotice", () => {
  it("defaults to the shared connecting copy and the spinner, with no colour", () => {
    expect(loadingNotice()).toEqual({ tone: "loading", label: CONNECTING, icon: "loading~spin" });
  });

  it("accepts custom copy and a detail line", () => {
    expect(loadingNotice("Loading runs…", "since 12:00")).toEqual({
      tone: "loading",
      label: "Loading runs…",
      detail: "since 12:00",
      icon: "loading~spin",
    });
  });
});

describe("emptyNotice", () => {
  it("uses the neutral info dot by default", () => {
    expect(emptyNotice("No cities registered")).toEqual({
      tone: "empty",
      label: "No cities registered",
      icon: "info",
    });
  });

  it("lets a pane override the icon (e.g. a cheerful check-all)", () => {
    expect(emptyNotice("Merge queue is empty", "Nothing waiting.", "check-all")).toEqual({
      tone: "empty",
      label: "Merge queue is empty",
      detail: "Nothing waiting.",
      icon: "check-all",
    });
  });
});

describe("errorNotice", () => {
  it("words every failed fetch the same way and folds the cause into the detail", () => {
    expect(errorNotice("beads", "HTTP 500")).toEqual({
      tone: "error",
      label: "Couldn't load beads.",
      detail: "HTTP 500",
      icon: "error",
      iconColor: "list.errorForeground",
    });
  });

  it("still carries the error colour when there is no cause to show", () => {
    expect(errorNotice("the merge queue")).toEqual({
      tone: "error",
      label: "Couldn't load the merge queue.",
      icon: "error",
      iconColor: "list.errorForeground",
    });
  });
});

describe("reconnectingNotice", () => {
  it("words a dropped link the same way everywhere, with the cause in the detail", () => {
    expect(reconnectingNotice("health probe failed — retrying in 500ms (attempt 2)")).toEqual({
      tone: "reconnecting",
      label: RECONNECTING,
      detail: "health probe failed — retrying in 500ms (attempt 2)",
      icon: "sync~spin",
      iconColor: "list.warningForeground",
    });
  });

  it("still carries the warning spinner when there is no cause to show", () => {
    expect(reconnectingNotice()).toEqual({
      tone: "reconnecting",
      label: RECONNECTING,
      icon: "sync~spin",
      iconColor: "list.warningForeground",
    });
  });

  it("uses its own copy, distinct from the first-load connecting line", () => {
    expect(RECONNECTING).not.toBe(CONNECTING);
    expect(reconnectingNotice().label).toBe(RECONNECTING);
  });
});

describe("the notice shape", () => {
  it("omits detail and iconColor when they do not apply (loading/empty)", () => {
    // A clean object — no `detail: undefined` / `iconColor: undefined` noise —
    // so a pane can spread it onto a tree node without carrying empty keys.
    expect(Object.keys(loadingNotice()).sort()).toEqual(["icon", "label", "tone"]);
    expect(Object.keys(emptyNotice("No cities")).sort()).toEqual(["icon", "label", "tone"]);
  });

  it("omits only detail when reconnecting (the tone always carries its warning colour)", () => {
    expect(Object.keys(reconnectingNotice()).sort()).toEqual(["icon", "iconColor", "label", "tone"]);
  });
});
