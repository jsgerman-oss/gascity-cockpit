// Tests for the fleet-status CLI target. Two jobs:
//   1. Exercise the target's pure logic (arg parsing, status rendering).
//   2. Assert the **core boundary contract** — that a sibling, non-extension
//      target can import `src/core` and reach the symbols it needs. This is the
//      buildable-boundary guarantee of cockpit-dc8.4, checked at `npm run check`
//      rather than only when someone first builds a companion.
import { describe, expect, it } from "vitest";
import * as core from "../../src/core/index.ts";
import { parseArgs } from "./fleet-status.ts";
import { formatFleetStatus, type FleetReport } from "./render.ts";

describe("core boundary is consumable from a sibling target", () => {
  it("re-exports the typed /v0 client and result helpers", () => {
    expect(typeof core.api.createCockpitClient).toBe("function");
    expect(typeof core.api.runApi).toBe("function");
    expect(typeof core.api.listCities).toBe("function");
  });

  it("re-exports the domain cores the scaffold names (beads/telemetry/mergeQueue)", () => {
    expect(core.beads).toBeDefined();
    expect(core.telemetry).toBeDefined();
    expect(core.mergeQueue).toBeDefined();
  });

  it("re-exports the rest of the portable surface", () => {
    for (const ns of ["fleet", "status", "town", "formulas", "discovery", "cities", "code"] as const) {
      expect(core[ns], `core.${ns} missing`).toBeDefined();
    }
  });

  it("exposes the localhost supervisor default through discovery", () => {
    expect(typeof core.discovery.DEFAULT_SUPERVISOR_BASE_URL).toBe("string");
    expect(core.discovery.DEFAULT_SUPERVISOR_BASE_URL).toMatch(/^https?:\/\//);
  });

  it("builds a real client against the boundary", () => {
    const client = core.api.createCockpitClient({ baseUrl: "http://127.0.0.1:8372" });
    expect(typeof client.GET).toBe("function");
  });
});

describe("parseArgs — endpoint precedence and flags", () => {
  it("falls back to the supervisor default with no input", () => {
    const result = parseArgs([], {});
    expect(result).toEqual({
      kind: "run",
      options: { endpoint: core.discovery.DEFAULT_SUPERVISOR_BASE_URL, timeoutMs: 10_000 },
    });
  });

  it("prefers $GASCITY_API_URL over the default", () => {
    const result = parseArgs([], { GASCITY_API_URL: "http://env:9000" });
    expect(result).toMatchObject({ kind: "run", options: { endpoint: "http://env:9000" } });
  });

  it("prefers a positional endpoint over the env var", () => {
    const result = parseArgs(["http://arg:1"], { GASCITY_API_URL: "http://env:9000" });
    expect(result).toMatchObject({ kind: "run", options: { endpoint: "http://arg:1" } });
  });

  it("prefers --endpoint over a positional arg", () => {
    const result = parseArgs(["http://pos:1", "--endpoint=http://flag:2"], {});
    expect(result).toMatchObject({ kind: "run", options: { endpoint: "http://flag:2" } });
  });

  it("parses --timeout", () => {
    const result = parseArgs(["--timeout=2500"], {});
    expect(result).toMatchObject({ kind: "run", options: { timeoutMs: 2500 } });
  });

  it("rejects a non-numeric --timeout", () => {
    expect(parseArgs(["--timeout=nope"], {})).toEqual({ kind: "error", message: "invalid --timeout: --timeout=nope" });
  });

  it("treats --help / -h as a help request", () => {
    expect(parseArgs(["--help"], {})).toEqual({ kind: "help" });
    expect(parseArgs(["-h"], {})).toEqual({ kind: "help" });
  });

  it("rejects unknown flags and surplus args", () => {
    expect(parseArgs(["--bogus"], {})).toMatchObject({ kind: "error" });
    expect(parseArgs(["one", "two"], {})).toEqual({ kind: "error", message: "unexpected argument: two" });
  });
});

describe("formatFleetStatus — rendering", () => {
  const report: FleetReport = {
    endpoint: "http://127.0.0.1:8372",
    cities: [
      {
        name: "blackrim-hq",
        running: true,
        status: "running",
        agents: [
          { name: "mayor", state: "running", running: true, activeBead: "cockpit-dc8", activity: "dispatching" },
          { name: "refinery", state: "idle", running: false },
        ],
      },
      { name: "ghost-town", running: false, agents: [] },
      { name: "broken", running: true, agents: [], error: "Network error" },
    ],
  };

  it("summarises city and agent counts", () => {
    const out = formatFleetStatus(report);
    expect(out).toContain("http://127.0.0.1:8372");
    expect(out).toContain("3 cities, 2 agents");
  });

  it("renders agents with state and active bead", () => {
    const out = formatFleetStatus(report);
    expect(out).toContain("mayor  [running]");
    expect(out).toContain("cockpit-dc8 (dispatching)");
    expect(out).toContain("refinery  [idle]");
  });

  it("marks empty cities and per-city errors", () => {
    const out = formatFleetStatus(report);
    expect(out).toContain("(no agents)");
    expect(out).toContain("! Network error");
  });

  it("singularises and handles the empty fleet", () => {
    expect(formatFleetStatus({ endpoint: "x", cities: [] })).toContain("0 cities, 0 agents");
    const one: FleetReport = { endpoint: "x", cities: [{ name: "solo", running: true, agents: [{ name: "a", state: "idle", running: false }] }] };
    expect(formatFleetStatus(one)).toContain("1 city, 1 agent");
  });
});
