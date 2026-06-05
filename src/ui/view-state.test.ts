import { describe, expect, it } from "vitest";
import {
  CONNECTING,
  STATE_LOOK,
  emptyNotice,
  errorNotice,
  loadingNotice,
} from "./view-state.ts";

describe("STATE_LOOK", () => {
  it("spins while loading and carries no colour", () => {
    expect(STATE_LOOK.loading).toEqual({ icon: "loading~spin" });
  });

  it("wears the theme error colour for the error tone, a neutral dot for empty", () => {
    expect(STATE_LOOK.error).toEqual({ icon: "error", iconColor: "list.errorForeground" });
    expect(STATE_LOOK.empty).toEqual({ icon: "info" });
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

describe("the notice shape", () => {
  it("omits detail and iconColor when they do not apply (loading/empty)", () => {
    // A clean object — no `detail: undefined` / `iconColor: undefined` noise —
    // so a pane can spread it onto a tree node without carrying empty keys.
    expect(Object.keys(loadingNotice()).sort()).toEqual(["icon", "label", "tone"]);
    expect(Object.keys(emptyNotice("No cities")).sort()).toEqual(["icon", "label", "tone"]);
  });
});
