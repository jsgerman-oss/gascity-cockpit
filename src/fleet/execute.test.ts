import { describe, expect, it } from "vitest";
import { makeRecord } from "../beads/fixtures.ts";
import type { CityRecords, ExplorerData } from "../beads/index.ts";
import { parseFleetQuery } from "./parse.ts";
import { runFleetQuery } from "./execute.ts";
import type { FleetQuery } from "./types.ts";

function city(name: string, records: CityRecords["records"]): CityRecords {
  return { city: name, running: true, records, partial: false };
}

// Two cities with a spread of derived statuses.
const DATA: ExplorerData = {
  cities: [
    city("gascity-cockpit", [
      makeRecord({ id: "cp-1" }, true, "gascity-cockpit"), // ready
      makeRecord({ id: "cp-2" }, false, "gascity-cockpit"), // blocked
      makeRecord({ id: "cp-3", status: "in_progress" }, null, "gascity-cockpit"),
      makeRecord({ id: "cp-4", status: "closed" }, null, "gascity-cockpit"),
    ]),
    city("blackrim-hq", [
      makeRecord({ id: "br-1" }, false, "blackrim-hq"), // blocked
      makeRecord({ id: "br-2", status: "escalated" }, null, "blackrim-hq"),
    ]),
  ],
};

function query(partial: Partial<FleetQuery> = {}): FleetQuery {
  return { filters: { includeClosed: false }, cityScope: null, ...partial };
}

describe("runFleetQuery — city scope", () => {
  it("resolves a partial scope token to the full city name", () => {
    const result = runFleetQuery(DATA, query({ cityScope: "cockpit", filters: { includeClosed: false, status: ["blocked"] } }));
    expect(result.scopedCities).toEqual(["gascity-cockpit"]);
    expect(result.rows.map((r) => r.record.bead.id)).toEqual(["cp-2"]);
    expect(result.rows[0].displayStatus).toBe("blocked");
    expect(result.unknownCity).toBeNull();
  });

  it("resolves an exact (case-insensitive) city name", () => {
    const result = runFleetQuery(DATA, query({ cityScope: "BlackRim-HQ", filters: { includeClosed: false, status: ["escalated"] } }));
    expect(result.scopedCities).toEqual(["blackrim-hq"]);
    expect(result.rows.map((r) => r.record.bead.id)).toEqual(["br-2"]);
  });

  it("flags an unknown city and returns no rows", () => {
    const result = runFleetQuery(DATA, query({ cityScope: "atlantis" }));
    expect(result.unknownCity).toBe("atlantis");
    expect(result.scopedCities).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("searches every city for a null scope", () => {
    const result = runFleetQuery(DATA, query({ filters: { includeClosed: false, status: ["blocked"] } }));
    expect(result.rows.map((r) => r.record.bead.id).sort()).toEqual(["br-1", "cp-2"]);
    expect(result.scopedCities).toEqual(["gascity-cockpit", "blackrim-hq"]);
  });
});

describe("runFleetQuery — filtering, ranking, limit", () => {
  it("hides closed beads by default and ranks most-actionable first", () => {
    const result = runFleetQuery(DATA, query());
    // cp-4 (closed) excluded; ordered in_progress → ready → blocked → escalated,
    // with the two blocked beads tie-broken by id (br-1 < cp-2).
    expect(result.rows.map((r) => r.record.bead.id)).toEqual(["cp-3", "cp-1", "br-1", "cp-2", "br-2"]);
    expect(result.totalMatched).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("surfaces closed beads when the query asks for them", () => {
    const result = runFleetQuery(DATA, query({ filters: { includeClosed: true, status: ["closed"] } }));
    expect(result.rows.map((r) => r.record.bead.id)).toEqual(["cp-4"]);
  });

  it("truncates to the limit and reports the untruncated total", () => {
    const result = runFleetQuery(DATA, query({ limit: 2 }));
    expect(result.rows.map((r) => r.record.bead.id)).toEqual(["cp-3", "cp-1"]);
    expect(result.truncated).toBe(true);
    expect(result.totalMatched).toBe(5);
  });
});

describe("parse → run integration", () => {
  it("answers 'show failing beads in cockpit' end to end", () => {
    const { query: q } = parseFleetQuery("show failing beads in cockpit");
    const result = runFleetQuery(DATA, q);
    // failing → blocked + escalated; cockpit → gascity-cockpit; only cp-2 is blocked there.
    expect(result.rows.map((r) => r.record.bead.id)).toEqual(["cp-2"]);
    expect(result.scopedCities).toEqual(["gascity-cockpit"]);
  });

  it("answers 'in-progress beads everywhere'", () => {
    const { query: q } = parseFleetQuery("in-progress beads everywhere");
    const result = runFleetQuery(DATA, q);
    expect(result.rows.map((r) => r.record.bead.id)).toEqual(["cp-3"]);
  });
});
