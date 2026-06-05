import { describe, expect, it } from "vitest";
import { cityPickLabel, rankCitiesForPicker } from "./city-picker.ts";
import type { CityInfo } from "../api/index.ts";

const city = (over: Partial<CityInfo> = {}): CityInfo => ({
  name: "alpha",
  path: "/Users/jayse/Code/alpha",
  running: true,
  ...over,
});

describe("rankCitiesForPicker", () => {
  it("puts running cities ahead of stopped ones", () => {
    const ranked = rankCitiesForPicker([
      city({ name: "stopped-1", running: false }),
      city({ name: "running-1", running: true }),
    ]);
    expect(ranked.map((c) => c.name)).toEqual(["running-1", "stopped-1"]);
  });

  it("sorts alphabetically within a run state", () => {
    const ranked = rankCitiesForPicker([city({ name: "delta" }), city({ name: "bravo" }), city({ name: "charlie" })]);
    expect(ranked.map((c) => c.name)).toEqual(["bravo", "charlie", "delta"]);
  });

  it("floats the preferred city to the top among running cities", () => {
    const ranked = rankCitiesForPicker(
      [city({ name: "alpha" }), city({ name: "blackrim-hq" }), city({ name: "zeta" })],
      "blackrim-hq",
    );
    expect(ranked[0].name).toBe("blackrim-hq");
  });

  it("does not promote a preferred city that is stopped above running cities", () => {
    const ranked = rankCitiesForPicker(
      [city({ name: "running-city", running: true }), city({ name: "home", running: false })],
      "home",
    );
    expect(ranked.map((c) => c.name)).toEqual(["running-city", "home"]);
  });

  it("does not mutate the input array", () => {
    const input = [city({ name: "b" }), city({ name: "a" })];
    rankCitiesForPicker(input);
    expect(input.map((c) => c.name)).toEqual(["b", "a"]);
  });
});

describe("cityPickLabel", () => {
  it("describes a running city by its status", () => {
    expect(cityPickLabel(city({ name: "alpha", status: "healthy" }))).toEqual({
      label: "alpha",
      description: "healthy",
      detail: "/Users/jayse/Code/alpha",
      name: "alpha",
    });
  });

  it("defaults a running city with no status to 'running'", () => {
    expect(cityPickLabel(city({ status: undefined })).description).toBe("running");
  });

  it("marks a stopped city", () => {
    expect(cityPickLabel(city({ running: false })).description).toBe("stopped");
    expect(cityPickLabel(city({ running: false, status: "suspended" })).description).toBe("stopped · suspended");
  });

  it("surfaces an errored city", () => {
    expect(cityPickLabel(city({ error: "unreachable" })).description).toBe("error: unreachable");
  });
});
