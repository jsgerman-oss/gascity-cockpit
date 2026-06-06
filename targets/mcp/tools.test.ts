// Tests for the MCP tool registry: every tool's advertised schema, and each
// handler driven against a mock /v0 server through the core boundary (no
// `vscode`, no sockets — the Seam-1 pattern, mirroring src/api tests). This is
// the cockpit-dc8.6 "tests for tool schemas + handlers" deliverable.
import { describe, expect, it } from "vitest";
import * as core from "../../src/core/index.ts";
import { mockFetch, jsonResponse, problemResponse } from "../../src/test/helpers.ts";
import { makeBead } from "../../src/beads/fixtures.ts";
import { TOOLS, findTool, type ToolContext, type ToolResult } from "./tools.ts";

const FIXED_NOW = new Date("2026-06-06T12:00:00Z");

/** Build a tool context whose client is driven by `handler`, plus the recorded calls. */
function contextFor(
  handler: (req: Request) => Response | Promise<Response>,
  allowWrites = false,
): { ctx: ToolContext; calls: Request[] } {
  const { fetch, calls } = mockFetch(handler);
  const client = core.api.createCockpitClient({ baseUrl: "http://stub", fetch });
  const repo = new core.beads.BeadsRepository({ getClient: () => client });
  return {
    ctx: { endpoint: "http://stub", client, repo, allowWrites, now: () => FIXED_NOW },
    calls,
  };
}

function pathOf(req: Request): string {
  return new URL(req.url).pathname;
}

/** Invoke a tool by name through the registry (exercising the wiring too). */
function call(name: string, ctx: ToolContext, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool.handler(ctx, args);
}

/** Narrow a tool's `data` to a record for property assertions. */
function data(result: ToolResult): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

describe("registry — every tool advertises a valid MCP schema", () => {
  it("exposes the six named tools in order", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "fleet_status",
      "query_beads",
      "merge_queue",
      "telemetry",
      "recent_events",
      "sling_bead",
    ]);
  });

  it("gives each tool a name, a description, and an object input schema", () => {
    for (const tool of TOOLS) {
      expect(tool.name, "name").toMatch(/^[a-z_]+$/);
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(20);
      expect(tool.inputSchema.type, `${tool.name} schema type`).toBe("object");
      // Properties, when present, must each declare a type.
      for (const [key, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(prop.type, `${tool.name}.${key}`).toBeDefined();
      }
    }
  });

  it("marks sling_bead's required arguments", () => {
    expect(findTool("sling_bead")?.inputSchema.required).toEqual(["city", "target"]);
  });
});

describe("fleet_status", () => {
  const cities = [
    { name: "blackrim-hq", path: "/a", running: true, status: "running" },
    { name: "ghost", path: "/b", running: false },
  ];
  const agents = [
    { name: "mayor", state: "running", running: true, active_bead: "cockpit-dc8", activity: "dispatching" },
    { name: "refinery", state: "idle", running: false },
  ];

  function handler(req: Request): Response {
    const p = pathOf(req);
    if (p === "/v0/cities") return jsonResponse({ items: cities });
    if (p === "/v0/city/blackrim-hq/agents") return jsonResponse({ items: agents });
    return problemResponse({ title: "not found" }, { status: 404 });
  }

  it("lists cities and the agents of running ones; skips stopped cities", async () => {
    const { ctx, calls } = contextFor(handler);
    const result = await call("fleet_status", ctx);
    const cityRows = data(result).cities as Array<Record<string, unknown>>;

    expect(data(result).endpoint).toBe("http://stub");
    expect(cityRows).toHaveLength(2);
    expect((cityRows[0].agents as unknown[]).length).toBe(2);
    expect(cityRows[1]).toMatchObject({ name: "ghost", running: false, agents: [] });
    // A stopped city is never queried for agents.
    expect(calls.some((c) => pathOf(c).includes("/ghost/agents"))).toBe(false);
  });

  it("maps agent fields including active bead and activity", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("fleet_status", ctx);
    const first = (data(result).cities as Array<Record<string, unknown>>)[0];
    expect((first.agents as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "mayor",
      state: "running",
      running: true,
      activeBead: "cockpit-dc8",
      activity: "dispatching",
    });
  });

  it("scopes to a single city when asked", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("fleet_status", ctx, { city: "blackrim-hq" });
    expect((data(result).cities as unknown[]).length).toBe(1);
  });

  it("errors for an unknown city", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("fleet_status", ctx, { city: "nope" });
    expect(result.isError).toBe(true);
    expect(data(result).error).toContain("unknown city");
  });

  it("surfaces a /v0/cities failure as a tool error", async () => {
    const { ctx } = contextFor(() => problemResponse({ title: "API down", status: 503 }, { status: 503 }));
    const result = await call("fleet_status", ctx);
    expect(result.isError).toBe(true);
    expect(data(result).error).toBeDefined();
  });
});

describe("query_beads", () => {
  const beads = [
    makeBead({ id: "a", title: "ship it", status: "in_progress", issue_type: "feature", assignee: "rig/pol" }),
    makeBead({ id: "b", title: "ready work", status: "open" }),
    makeBead({ id: "c", title: "done", status: "closed", issue_type: "bug" }),
  ];

  function handler(req: Request): Response {
    const p = pathOf(req);
    if (p === "/v0/cities") return jsonResponse({ items: [{ name: "hq", path: "/a", running: true }] });
    if (p === "/v0/city/hq/beads") return jsonResponse({ items: beads });
    if (p === "/v0/city/hq/beads/ready") return jsonResponse({ items: [{ id: "b" }] });
    return problemResponse({ title: "not found" }, { status: 404 });
  }

  it("hides closed and returns open work by default", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("query_beads", ctx);
    const ids = (data(result).beads as Array<{ id: string }>).map((b) => b.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).not.toContain("c");
  });

  it("derives display status (open + ready => ready)", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("query_beads", ctx, { status: "ready" });
    const rows = data(result).beads as Array<{ id: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "b", status: "ready" });
  });

  it("filters by structured status", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("query_beads", ctx, { status: "in_progress" });
    expect((data(result).beads as Array<{ id: string }>).map((b) => b.id)).toEqual(["a"]);
  });

  it("includes closed beads when asked", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("query_beads", ctx, { includeClosed: true });
    expect((data(result).beads as Array<{ id: string }>).map((b) => b.id)).toContain("c");
  });

  it("supports the natural-language query path and echoes the interpretation", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("query_beads", ctx, { query: "in progress" });
    expect((data(result).beads as Array<{ id: string }>).map((b) => b.id)).toEqual(["a"]);
    expect(data(result).interpreted).toContain("In progress");
  });

  it("treats an explicit empty assignee as unassigned", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("query_beads", ctx, { assignee: "" });
    // 'b' (and 'a' has an assignee) — only unassigned open beads match.
    expect((data(result).beads as Array<{ id: string }>).map((b) => b.id)).toEqual(["b"]);
  });
});

describe("merge_queue", () => {
  const beads = [
    makeBead({ id: "m1", status: "open", assignee: "gascity-cockpit/gastown.refinery", metadata: { branch: "polecat/m1", target: "main" } }),
    makeBead({ id: "m2", status: "open", metadata: { rejection_reason: "rebase conflict" } }),
    makeBead({ id: "m3", status: "closed", metadata: { merge_result: "merged", merged_sha: "abc123" } }),
    makeBead({ id: "plain", status: "in_progress" }),
  ];

  function handler(req: Request): Response {
    const p = pathOf(req);
    if (p === "/v0/cities") return jsonResponse({ items: [{ name: "hq", path: "/a", running: true }] });
    if (p === "/v0/city/hq/beads") return jsonResponse({ items: beads });
    if (p === "/v0/city/hq/beads/ready") return jsonResponse({ items: [] });
    return problemResponse({ title: "not found" }, { status: 404 });
  }

  it("classifies awaiting / rejected / merged and excludes plain work", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("merge_queue", ctx);
    expect(data(result).summary).toMatchObject({ total: 3, awaiting: 1, rejected: 1, merged: 1 });
    const states = (data(result).entries as Array<{ beadId: string; state: string }>);
    expect(states.find((e) => e.beadId === "m1")?.state).toBe("awaiting");
    expect(states.find((e) => e.beadId === "m2")?.state).toBe("rejected");
    expect(states.find((e) => e.beadId === "m3")?.state).toBe("merged");
    expect(states.some((e) => e.beadId === "plain")).toBe(false);
  });

  it("loads closed beads so merged history appears (requests all=true)", async () => {
    const { ctx, calls } = contextFor(handler);
    await call("merge_queue", ctx);
    const beadsCall = calls.find((c) => pathOf(c) === "/v0/city/hq/beads");
    expect(new URL(beadsCall!.url).searchParams.get("all")).toBe("true");
  });
});

describe("telemetry", () => {
  const envelopes = [
    { type: "worker.operation", seq: 1, ts: "2026-06-06T11:00:00Z", actor: "mayor", payload: { agent_name: "mayor", bead_id: "cockpit-dc8", model: "claude-opus", provider: "claude", operation: "session.submit", result: "ok", duration_ms: 1200 } },
    { type: "worker.operation", seq: 2, ts: "2026-06-06T11:01:00Z", actor: "polecat", payload: { agent_name: "polecat", bead_id: "cockpit-dc8.6", model: "claude-opus", provider: "claude", operation: "session.submit", result: "ok", duration_ms: 800 } },
  ];

  function handler(req: Request): Response {
    const p = pathOf(req);
    if (p === "/v0/cities") return jsonResponse({ items: [{ name: "hq", path: "/a", running: true }] });
    if (p === "/v0/city/hq/events") return jsonResponse({ items: envelopes, total: envelopes.length });
    return problemResponse({ title: "not found" }, { status: 404 });
  }

  it("rolls up worker operations per city, per model", async () => {
    const { ctx, calls } = contextFor(handler);
    const result = await call("telemetry", ctx);
    const city = (data(result).cities as Array<Record<string, unknown>>)[0];
    expect((city.totals as { operations: number }).operations).toBe(2);
    const byModel = city.byModel as Array<{ model: string; operations: number }>;
    expect(byModel).toEqual([{ model: "claude-opus", providers: ["claude"], operations: 2, succeeded: 2, failed: 0, durationMs: 2000 }]);
    expect((city.topAgents as unknown[]).length).toBe(2);
    // It filtered the events feed to worker.operation.
    const eventsCall = calls.find((c) => pathOf(c) === "/v0/city/hq/events");
    expect(new URL(eventsCall!.url).searchParams.get("type")).toBe("worker.operation");
  });

  it("counts every operation even when the events feed returns newest-first", async () => {
    // Reverse the feed (descending seq) — the store drops seq <= max, so without
    // an ascending sort only the first (highest-seq) op would survive.
    const reversed = [...envelopes].reverse();
    const { ctx } = contextFor((req) => {
      const p = pathOf(req);
      if (p === "/v0/cities") return jsonResponse({ items: [{ name: "hq", path: "/a", running: true }] });
      if (p === "/v0/city/hq/events") return jsonResponse({ items: reversed, total: reversed.length });
      return problemResponse({ title: "not found" }, { status: 404 });
    });
    const result = await call("telemetry", ctx);
    const city = (data(result).cities as Array<Record<string, unknown>>)[0];
    expect((city.totals as { operations: number }).operations).toBe(2);
  });

  it("reports cost as not-yet-measured when the supervisor omits it", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("telemetry", ctx);
    expect(data(result).anyCostMeasured).toBe(false);
    expect(data(result).note).toContain("not yet instrumented");
  });

  it("errors for an unknown or stopped city", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("telemetry", ctx, { city: "nope" });
    expect(result.isError).toBe(true);
  });
});

describe("recent_events", () => {
  const events = [
    { type: "session.crashed", seq: 5, ts: "2026-06-06T11:00:00Z", actor: "witness", subject: "polecat", message: "crashed" },
    { type: "bead.updated", seq: 6, ts: "2026-06-06T11:05:00Z", actor: "mayor" },
  ];

  function handler(req: Request): Response {
    const p = pathOf(req);
    if (p === "/v0/cities") return jsonResponse({ items: [{ name: "hq", path: "/a", running: true }] });
    if (p === "/v0/city/hq/events") return jsonResponse({ items: events, total: events.length });
    return problemResponse({ title: "not found" }, { status: 404 });
  }

  it("returns compact event rows newest-first", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("recent_events", ctx);
    const rows = data(result).events as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ city: "hq", type: "bead.updated", seq: 6 });
    expect(rows[1]).toMatchObject({ type: "session.crashed", subject: "polecat", message: "crashed" });
  });

  it("passes type/actor/since filters through to /v0 and skips the city list for an explicit city", async () => {
    const { ctx, calls } = contextFor(handler);
    await call("recent_events", ctx, { city: "hq", type: "session.crashed", actor: "witness", since: "5m" });
    expect(calls.some((c) => pathOf(c) === "/v0/cities")).toBe(false);
    const eventsCall = calls.find((c) => pathOf(c) === "/v0/city/hq/events");
    const q = new URL(eventsCall!.url).searchParams;
    expect(q.get("type")).toBe("session.crashed");
    expect(q.get("actor")).toBe("witness");
    expect(q.get("since")).toBe("5m");
  });

  it("caps to the requested limit", async () => {
    const { ctx } = contextFor(handler);
    const result = await call("recent_events", ctx, { limit: 1 });
    expect((data(result).events as unknown[]).length).toBe(1);
    expect(data(result).truncated).toBe(true);
  });
});

describe("sling_bead — the guarded write", () => {
  function handler(req: Request): Response {
    const p = pathOf(req);
    if (p === "/v0/city/hq/sling") return jsonResponse({ target: "hq/gastown.polecat", mode: "route" });
    return problemResponse({ title: "not found" }, { status: 404 });
  }

  it("refuses to run when writes are disabled and issues no request", async () => {
    const { ctx, calls } = contextFor(handler, false);
    const result = await call("sling_bead", ctx, { city: "hq", target: "hq/gastown.polecat", bead: "x" });
    expect(result.isError).toBe(true);
    expect(data(result).error).toBe("writes disabled");
    expect(calls).toHaveLength(0);
  });

  it("slings when writes are enabled, POSTing to /v0 with the anti-CSRF header", async () => {
    const { ctx, calls } = contextFor(handler, true);
    const result = await call("sling_bead", ctx, { city: "hq", target: "hq/gastown.polecat", bead: "x", force: true });
    expect(result.isError).toBeFalsy();
    expect(data(result)).toMatchObject({ city: "hq", target: "hq/gastown.polecat" });
    const slingCall = calls.find((c) => pathOf(c) === "/v0/city/hq/sling");
    expect(slingCall?.method).toBe("POST");
    expect(slingCall?.headers.get("X-GC-Request")).toBeTruthy();
  });

  it("validates required target even with writes enabled", async () => {
    const { ctx } = contextFor(handler, true);
    const result = await call("sling_bead", ctx, { city: "hq" } as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(data(result).error).toContain("target");
  });
});
