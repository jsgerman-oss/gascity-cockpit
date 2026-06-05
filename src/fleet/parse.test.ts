import { describe, expect, it } from "vitest";
import { parseFleetQuery } from "./parse.ts";

describe("parseFleetQuery — status words", () => {
  it("maps 'failing' to the attention-needing states (blocked + escalated)", () => {
    const { query } = parseFleetQuery("show failing beads in cockpit");
    expect(query.filters.status).toEqual(["blocked", "escalated"]);
    expect(query.cityScope).toBe("cockpit");
  });

  it("recognises 'blocked'", () => {
    expect(parseFleetQuery("blocked beads").query.filters.status).toEqual(["blocked"]);
  });

  it("treats 'in progress' as a status, not a city scope", () => {
    const { query } = parseFleetQuery("in progress");
    expect(query.filters.status).toEqual(["in_progress"]);
    expect(query.cityScope).toBeNull();
  });

  it("maps the active/wip synonyms to in_progress", () => {
    expect(parseFleetQuery("active work").query.filters.status).toEqual(["in_progress"]);
    expect(parseFleetQuery("wip").query.filters.status).toEqual(["in_progress"]);
  });

  it("unions multiple status words and orders them by actionability", () => {
    const { query } = parseFleetQuery("ready or blocked beads");
    expect(query.filters.status).toEqual(["ready", "blocked"]);
  });

  it("reveals closed beads for the done/closed family", () => {
    const { query } = parseFleetQuery("closed beads");
    expect(query.filters.status).toEqual(["closed"]);
    expect(query.filters.includeClosed).toBe(true);
  });

  it("treats 'done' like closed and keeps other constraints", () => {
    const { query } = parseFleetQuery("done tasks in alpha");
    expect(query.filters.status).toEqual(["closed"]);
    expect(query.filters.includeClosed).toBe(true);
    expect(query.filters.type).toBe("task");
    expect(query.cityScope).toBe("alpha");
  });

  it("leaves status unset (closed hidden) for a bare 'open' query", () => {
    const { query } = parseFleetQuery("open beads");
    expect(query.filters.status).toBeUndefined();
    expect(query.filters.includeClosed).toBe(false);
  });
});

describe("parseFleetQuery — type, priority, assignee", () => {
  it("maps a plural type word to its issue_type", () => {
    expect(parseFleetQuery("show me the bugs").query.filters.type).toBe("bug");
    expect(parseFleetQuery("features").query.filters.type).toBe("feature");
    expect(parseFleetQuery("epics").query.filters.type).toBe("epic");
  });

  it("reads the explicit p0–p3 priority form", () => {
    expect(parseFleetQuery("p0 beads").query.filters.priority).toBe(0);
    expect(parseFleetQuery("p3 chores").query.filters.priority).toBe(3);
  });

  it("maps priority words", () => {
    expect(parseFleetQuery("critical bugs").query.filters.priority).toBe(0);
    expect(parseFleetQuery("urgent").query.filters.priority).toBe(0);
    expect(parseFleetQuery("high priority work").query.filters.priority).toBe(1);
    expect(parseFleetQuery("low-pri beads").query.filters.priority).toBe(3);
  });

  it("matches unassigned beads with the empty-string assignee", () => {
    expect(parseFleetQuery("unassigned beads").query.filters.assignee).toBe("");
  });

  it("captures an explicit assignee including rig/agent punctuation", () => {
    const { query } = parseFleetQuery("beads assigned to gascity-cockpit/gastown.refinery");
    expect(query.filters.assignee).toBe("gascity-cockpit/gastown.refinery");
  });
});

describe("parseFleetQuery — text, limit, scope", () => {
  it("extracts quoted text without parsing its inner words", () => {
    const { query } = parseFleetQuery('blocked beads matching "feature registry"');
    expect(query.filters.text).toBe("feature registry");
    expect(query.filters.status).toEqual(["blocked"]);
  });

  it("extracts a single-word 'containing' text term", () => {
    expect(parseFleetQuery("beads containing palette").query.filters.text).toBe("palette");
  });

  it("reads an explicit result cap", () => {
    expect(parseFleetQuery("top 5 blocked beads").query.limit).toBe(5);
  });

  it("reads the 'N beads' cap even with a status word between the number and noun", () => {
    const { query } = parseFleetQuery("10 blocked beads");
    expect(query.limit).toBe(10);
    expect(query.filters.status).toEqual(["blocked"]);
  });

  it("scopes to a city via in/for and tolerates a leading 'the'", () => {
    expect(parseFleetQuery("blocked beads in cockpit").query.cityScope).toBe("cockpit");
    expect(parseFleetQuery("beads for cockpit").query.cityScope).toBe("cockpit");
    expect(parseFleetQuery("beads in the cockpit").query.cityScope).toBe("cockpit");
  });

  it("keeps the fleet-wide default for 'all cities' / 'everywhere'", () => {
    expect(parseFleetQuery("ready beads across all cities").query.cityScope).toBeNull();
    expect(parseFleetQuery("blocked beads everywhere").query.cityScope).toBeNull();
  });

  it("defaults to all cities and open beads for an empty query", () => {
    const parsed = parseFleetQuery("");
    expect(parsed.query.cityScope).toBeNull();
    expect(parsed.query.filters).toEqual({ includeClosed: false });
    expect(parsed.summary).toBe("open beads · all cities");
  });
});

describe("parseFleetQuery — summary and unmatched", () => {
  it("restates a compound query deterministically", () => {
    const { summary } = parseFleetQuery("failing beads in cockpit");
    expect(summary).toBe("Blocked / Escalated · city cockpit");
  });

  it("summarises type + priority + limit", () => {
    const { summary } = parseFleetQuery("top 3 critical bugs");
    expect(summary).toBe("type bug, P0 · critical · all cities · top 3");
  });

  it("reports words it did not understand", () => {
    const { unmatched } = parseFleetQuery("show frobnitz beads in cockpit");
    expect(unmatched).toEqual(["frobnitz"]);
  });

  it("leaves nothing unmatched for a fully-understood query", () => {
    expect(parseFleetQuery("blocked p1 features in cockpit").unmatched).toEqual([]);
  });
});
