import { describe, expect, it } from "vitest";
import { CITY_PLACEHOLDER, cityStatusKind, cityStatusText } from "./presentation.ts";
import type { CityInfo } from "../api/index.ts";

const city = (over: Partial<CityInfo> = {}): CityInfo => ({
  name: "blackrim-hq",
  path: "/Users/jayse/Code",
  running: true,
  ...over,
});

describe("cityStatusKind", () => {
  it("treats an error as the dominant state", () => {
    expect(cityStatusKind(city({ error: "boom", running: true }))).toBe("error");
  });

  it("distinguishes running from stopped", () => {
    expect(cityStatusKind(city({ running: true }))).toBe("running");
    expect(cityStatusKind(city({ running: false }))).toBe("stopped");
  });
});

describe("cityStatusText", () => {
  it("describes a running city by its status, defaulting to 'running'", () => {
    expect(cityStatusText(city({ status: "healthy" }))).toBe("healthy");
    expect(cityStatusText(city({ status: undefined }))).toBe("running");
  });

  it("describes a stopped city, appending a status when present", () => {
    expect(cityStatusText(city({ running: false }))).toBe("stopped");
    expect(cityStatusText(city({ running: false, status: "suspended" }))).toBe("stopped · suspended");
  });

  it("renders an errored city tersely by default", () => {
    expect(cityStatusText(city({ error: "unreachable" }))).toBe("error");
  });

  it("folds the error message in when detail is requested", () => {
    expect(cityStatusText(city({ error: "unreachable" }), { detail: true })).toBe("error: unreachable");
  });

  it("an error outranks the run state in the phrase", () => {
    // A city can report an error while still flagged running; the error wins.
    expect(cityStatusText(city({ running: true, status: "healthy", error: "boom" }))).toBe("error");
  });
});

describe("CITY_PLACEHOLDER", () => {
  it("exposes the shared connecting / no-cities copy", () => {
    expect(CITY_PLACEHOLDER.connecting).toBe("Connecting to supervisor…");
    expect(CITY_PLACEHOLDER.noCities).toBe("No cities registered");
  });
});
