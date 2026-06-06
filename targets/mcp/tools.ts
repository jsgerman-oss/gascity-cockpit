// The MCP tool registry — the portable, transport-free heart of the gascity MCP
// context server (cockpit-dc8.6).
//
// Each tool is a pure `{ name, description, inputSchema, handler }` record. A
// handler takes a {@link ToolContext} (a typed `/v0` client + a bead repository
// + the write gate) and the parsed call arguments, and resolves to a
// {@link ToolResult} — structured data the transport renders into an MCP content
// block. Handlers reach the supervisor only through the shared **core boundary**
// (`src/core`), exactly like the CLI target, so this whole module is `vscode`-free
// and unit-testable against a mock-fetch client (see tools.test.ts). The stdio /
// JSON-RPC framing lives in ./protocol.ts; nothing here knows about stdin/stdout.
import * as core from "../../src/core/index.ts";

/** A JSON-Schema object describing one tool's arguments (the MCP `inputSchema`). */
export interface JsonSchema {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/** One property within a tool's input schema. Intentionally a small subset. */
export interface JsonSchemaProperty {
  type: string | string[];
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  /** For object-typed properties (e.g. formula `vars`). */
  additionalProperties?: boolean | JsonSchemaProperty;
}

/** Everything a tool handler needs to talk to one supervisor. */
export interface ToolContext {
  /** The `/v0` base URL the client points at (surfaced in some tool output). */
  endpoint: string;
  /** The typed `/v0` client (built once, shared across calls). */
  client: core.api.CockpitClient;
  /** Bead repository over the same client; fans out across cities. */
  repo: core.beads.BeadsRepository;
  /** When false, the mutating tools (sling) refuse to run. */
  allowWrites: boolean;
  /** Clock injection so derived statuses are deterministic in tests. */
  now?: () => Date;
}

/** A tool's outcome: structured data, plus whether it is an error the model should see. */
export interface ToolResult {
  /** Structured payload; the transport serialises it to JSON in a text block. */
  data: unknown;
  /** True when this is a tool-level error (mapped to MCP `isError: true`). */
  isError?: boolean;
}

/** A registered tool: its advertised schema and its handler. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

// --- argument readers -------------------------------------------------------
// MCP arguments arrive as an untyped object; read defensively so a bad value
// degrades to "absent" rather than throwing deep in a handler.

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Read a `{ [k]: string }` map (e.g. formula vars); non-string values are dropped. */
function readStringRecord(args: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const v = args[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Shape a normalised /v0 error into a stable, serialisable object. */
function errorData(error: core.api.NormalizedError): Record<string, unknown> {
  return {
    error: error.title,
    ...(error.detail ? { detail: error.detail } : {}),
    status: error.status,
    ...(error.requestId ? { requestId: error.requestId } : {}),
  };
}

/** Hard ceiling on rows/events a single tool call returns, to bound payload size. */
const MAX_ROWS = 200;

// --- shared shaping ---------------------------------------------------------

/** Reduce a bead record to the fields the query tool returns. */
function beadRow(record: core.beads.BeadRecord, now: Date): Record<string, unknown> {
  const bead = record.bead;
  return {
    id: bead.id,
    city: record.city,
    title: bead.title ?? "",
    status: core.beads.deriveDisplayStatus(record, now),
    rawStatus: bead.status ?? "",
    assignee: core.beads.beadAssignee(bead),
    rig: core.beads.beadRig(bead),
    type: core.beads.beadType(bead),
    priority: typeof bead.priority === "number" ? bead.priority : null,
    ready: record.ready,
  };
}

/** Cities that failed to load during a fan-out, for a `partial` flag. */
function cityErrors(data: core.beads.ExplorerData): Array<{ city: string; error: string }> {
  return data.cities
    .filter((c) => c.error)
    .map((c) => ({ city: c.city, error: c.error as string }));
}

// --- fleet_status -----------------------------------------------------------

const fleetStatus: ToolDefinition = {
  name: "fleet_status",
  description:
    "Fleet & city status over /v0: every city the supervisor knows, whether it is " +
    "running, and the agents in each (state, running, active bead, activity). " +
    "Pass `city` to scope to one city.",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "Limit to a single city by exact name." },
    },
  },
  async handler(ctx, args) {
    const cityFilter = readString(args, "city");
    const cities = await core.api.listCities(ctx.client);
    if (!cities.ok) return { data: errorData(cities.error), isError: true };

    let items = cities.data.items ?? [];
    if (cityFilter) {
      items = items.filter((c) => c.name === cityFilter);
      if (items.length === 0) {
        return { data: { error: `unknown city: ${cityFilter}` }, isError: true };
      }
    }

    const rows = await Promise.all(
      items.map(async (city) => {
        const base = { name: city.name, running: city.running, status: city.status ?? null };
        if (!city.running) return { ...base, agents: [] as unknown[] };
        const agents = await core.api.runApi(() =>
          ctx.client.GET("/v0/city/{cityName}/agents", { params: { path: { cityName: city.name } } }),
        );
        if (!agents.ok) return { ...base, agents: [] as unknown[], error: agents.error.title };
        return {
          ...base,
          agents: (agents.data.items ?? []).map((agent) => ({
            name: agent.name,
            state: agent.state,
            running: agent.running,
            activeBead: agent.active_bead ?? null,
            activity: agent.activity ?? null,
          })),
        };
      }),
    );

    return { data: { endpoint: ctx.endpoint, cities: rows } };
  },
};

// --- query_beads ------------------------------------------------------------

const queryBeads: ToolDefinition = {
  name: "query_beads",
  description:
    "Query beads across all cities (or one) by status / rig / assignee / type / text / " +
    "priority. Alternatively pass a free-form natural-language `query` (e.g. " +
    '"blocked bugs in cockpit top 10") parsed by the fleet-query grammar. ' +
    "Closed beads are hidden unless `includeClosed` is true; operational wisps are " +
    "hidden unless `includeOperational` is true.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language query; overrides the structured filters below." },
      city: { type: "string", description: "Limit to a single city by exact name." },
      status: { type: "string", description: "Display status, e.g. ready, blocked, in_progress (comma-separate for several)." },
      rig: { type: "string", description: "Exact rig name." },
      assignee: { type: "string", description: 'Exact assignee; "" matches unassigned beads.' },
      type: { type: "string", description: "Exact issue_type, e.g. bug, feature, chore, epic." },
      text: { type: "string", description: "Case-insensitive substring of id or title." },
      priority: { type: "number", description: "Exact numeric priority (0=critical … 3=low)." },
      includeClosed: { type: "boolean", description: "Include closed beads (default false)." },
      includeOperational: { type: "boolean", description: "Include operational wisps/sessions/mail (default false)." },
      limit: { type: "number", description: "Max beads per city to load from the server." },
    },
  },
  async handler(ctx, args) {
    const now = (ctx.now ?? (() => new Date()))();
    const cityFilter = readString(args, "city");
    const includeClosed = readBoolean(args, "includeClosed") ?? false;
    const limit = readNumber(args, "limit");
    const queryText = readString(args, "query");

    let explorer: core.beads.ExplorerData;
    try {
      explorer = await ctx.repo.loadExplorer({ includeClosed, ...(limit ? { limit } : {}) });
    } catch (err) {
      return { data: { error: err instanceof Error ? err.message : String(err) }, isError: true };
    }

    let records = explorer.cities.flatMap((c) => c.records);
    if (cityFilter) records = records.filter((r) => r.city === cityFilter);

    let matched: core.beads.BeadRecord[];
    let interpreted: string | undefined;
    let unmatched: string[] | undefined;

    if (queryText) {
      const parsed = core.fleet.parseFleetQuery(queryText);
      // Re-scope the explorer to the records we already loaded; runFleetQuery
      // resolves the query's own city scope token against them.
      const result = core.fleet.runFleetQuery({ cities: cityScopedView(records) }, parsed.query, now);
      matched = result.rows.map((r) => r.record);
      interpreted = parsed.summary;
      unmatched = parsed.unmatched.length > 0 ? parsed.unmatched : undefined;
    } else {
      const filters: core.beads.BeadFilters = {
        includeClosed,
        hideOperational: readBoolean(args, "includeOperational") === true ? false : true,
      };
      const status = readString(args, "status");
      if (status) filters.status = status.split(",").map((s) => s.trim()).filter(Boolean);
      const rig = readString(args, "rig");
      if (rig) filters.rig = rig;
      // assignee is special: an explicit empty string means "unassigned".
      if (typeof args.assignee === "string") filters.assignee = args.assignee.trim();
      const type = readString(args, "type");
      if (type) filters.type = type;
      const text = readString(args, "text");
      if (text) filters.text = text;
      const priority = readNumber(args, "priority");
      if (priority !== undefined) filters.priority = priority;
      matched = core.beads.sortRecords(core.beads.filterRecords(records, filters, now), now);
    }

    const truncated = matched.length > MAX_ROWS;
    const rows = matched.slice(0, MAX_ROWS).map((r) => beadRow(r, now));
    const errors = cityErrors(explorer);

    return {
      data: {
        count: matched.length,
        ...(truncated ? { truncated: true, returned: rows.length } : {}),
        ...(interpreted ? { interpreted } : {}),
        ...(unmatched ? { unmatched } : {}),
        ...(errors.length > 0 ? { partial: true, errors } : {}),
        beads: rows,
      },
    };
  },
};

/** Group flat records back into the per-city shape runFleetQuery expects. */
function cityScopedView(records: core.beads.BeadRecord[]): core.beads.ExplorerData["cities"] {
  const byCity = new Map<string, core.beads.BeadRecord[]>();
  for (const r of records) {
    const list = byCity.get(r.city) ?? [];
    list.push(r);
    byCity.set(r.city, list);
  }
  return [...byCity.entries()].map(([city, recs]) => ({ city, running: true, records: recs, partial: false }));
}

// --- merge_queue ------------------------------------------------------------

const mergeQueue: ToolDefinition = {
  name: "merge_queue",
  description:
    "Merge-queue state derived from beads: entries awaiting the refinery, rejected " +
    "(kicked back for rework), or already merged — with branch / target / PR url / " +
    "rejection reason. Closed beads are included so merged history shows. Pass " +
    "`city` to scope to one city.",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "Limit to a single city by exact name." },
    },
  },
  async handler(ctx, args) {
    const cityFilter = readString(args, "city");
    let explorer: core.beads.ExplorerData;
    try {
      // Merged beads are usually closed, so include them to show landed work.
      explorer = await ctx.repo.loadExplorer({ includeClosed: true });
    } catch (err) {
      return { data: { error: err instanceof Error ? err.message : String(err) }, isError: true };
    }

    let records = explorer.cities.flatMap((c) => c.records);
    if (cityFilter) records = records.filter((r) => r.city === cityFilter);

    const entries = core.mergeQueue.deriveMergeQueue(records);
    const summary = core.mergeQueue.summarize(entries);
    const errors = cityErrors(explorer);

    return {
      data: {
        summary,
        ...(errors.length > 0 ? { partial: true, errors } : {}),
        entries,
      },
    };
  },
};

// --- telemetry --------------------------------------------------------------

interface ModelLine {
  model: string;
  providers: string[];
  operations: number;
  succeeded: number;
  failed: number;
  durationMs: number;
}

/** Merge the per-agent model rollups into a city-wide by-model ("tier") view. */
function modelBreakdown(agents: readonly core.telemetry.ScopeRollup[]): ModelLine[] {
  const map = new Map<string, ModelLine & { providerSet: Set<string> }>();
  for (const agent of agents) {
    for (const m of agent.models) {
      const cur = map.get(m.model) ?? {
        model: m.model,
        providers: [],
        providerSet: new Set<string>(),
        operations: 0,
        succeeded: 0,
        failed: 0,
        durationMs: 0,
      };
      cur.operations += m.operations;
      cur.succeeded += m.succeeded;
      cur.failed += m.failed;
      cur.durationMs += m.durationMs;
      for (const p of m.providers) cur.providerSet.add(p);
      map.set(m.model, cur);
    }
  }
  return [...map.values()]
    .map((x) => ({ model: x.model, providers: [...x.providerSet].sort(), operations: x.operations, succeeded: x.succeeded, failed: x.failed, durationMs: x.durationMs }))
    .sort((a, b) => b.operations - a.operations || a.model.localeCompare(b.model));
}

/** Adapt a recent-events envelope into the SSE shape the tested parser consumes. */
function envelopeToSSE(envelope: unknown): core.api.SSEMessage {
  const env = envelope as { type?: unknown; seq?: unknown };
  return {
    event: typeof env.type === "string" ? env.type : "message",
    data: JSON.stringify(envelope),
    id: typeof env.seq === "number" ? String(env.seq) : undefined,
  };
}

const TOP_AGENTS = 20;

const telemetry: ToolDefinition = {
  name: "telemetry",
  description:
    "Cost & tier telemetry rolled up from recent worker.operation events, per city: " +
    "totals, the busiest agents, and a per-model (tier proxy) breakdown. Token/cost " +
    "fields read live but the supervisor reports them as unmeasured today — " +
    "`anyCostMeasured` flags whether any landed. Pass `since` (e.g. 1h, 30m) and " +
    "`limit` to widen/narrow the window; `city` to scope.",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "Limit to a single city by exact name." },
      since: { type: "string", description: "Look-back window as a Go duration (default 1h)." },
      limit: { type: "number", description: "Max events to scan per city (default 500)." },
    },
  },
  async handler(ctx, args) {
    const cityFilter = readString(args, "city");
    const since = readString(args, "since") ?? "1h";
    const limit = readNumber(args, "limit") ?? 500;

    const cities = await core.api.listCities(ctx.client);
    if (!cities.ok) return { data: errorData(cities.error), isError: true };

    let targets = (cities.data.items ?? []).filter((c) => c.running);
    if (cityFilter) {
      targets = targets.filter((c) => c.name === cityFilter);
      if (targets.length === 0) return { data: { error: `unknown or stopped city: ${cityFilter}` }, isError: true };
    }

    const perCity = await Promise.all(
      targets.map(async (city) => {
        const res = await core.api.runApi(() =>
          ctx.client.GET("/v0/city/{cityName}/events", {
            params: {
              path: { cityName: city.name },
              query: { type: core.telemetry.WORKER_OPERATION_TYPE, since, limit },
            },
          }),
        );
        if (!res.ok) return { city: city.name, error: res.error.title };

        // One store per city: the store de-duplicates by supervisor `seq`, and
        // seq is city-local, so folding multiple cities into one store would drop
        // colliding sequences. Keep them isolated and report per city.
        const store = new core.telemetry.TelemetryStore();
        const items = res.data.items ?? [];
        // The store drops any op whose seq is <= the highest seen (built for the
        // ascending-seq SSE stream). The recent-events GET makes no order
        // guarantee, so sort ascending before folding or newer-first pages would
        // drop everything but the first op.
        const ops = items
          .map((env) => core.telemetry.parseWorkerOperation(envelopeToSSE(env)))
          .filter((op): op is NonNullable<typeof op> => op !== null)
          .sort((a, b) => a.seq - b.seq);
        for (const op of ops) store.addOperation(op);
        const state = store.state;
        return {
          city: city.name,
          eventsScanned: items.length,
          anyCostMeasured: state.anyCostMeasured,
          totals: state.totals,
          byModel: modelBreakdown(state.agents),
          topAgents: state.agents.slice(0, TOP_AGENTS).map((a) => ({
            agent: a.key,
            operations: a.operations,
            succeeded: a.succeeded,
            failed: a.failed,
            durationMs: a.durationMs,
            models: a.models.map((m) => m.model),
          })),
        };
      }),
    );

    const errors = perCity.filter((c): c is { city: string; error: string } => "error" in c);
    const ok = perCity.filter((c): c is Extract<typeof c, { totals: unknown }> => "totals" in c);

    return {
      data: {
        since,
        anyCostMeasured: ok.some((c) => c.anyCostMeasured),
        note: ok.some((c) => c.anyCostMeasured)
          ? undefined
          : "Token/cost not yet instrumented by the supervisor; operation counts are exact.",
        ...(errors.length > 0 ? { partial: true, errors } : {}),
        cities: ok,
      },
    };
  },
};

// --- recent_events ----------------------------------------------------------

/** Reduce a recent-events envelope to a compact, serialisable summary row. */
function eventRow(city: string, envelope: unknown): Record<string, unknown> {
  const env = envelope as {
    seq?: unknown;
    ts?: unknown;
    type?: unknown;
    actor?: unknown;
    subject?: unknown;
    message?: unknown;
  };
  return {
    city,
    seq: typeof env.seq === "number" ? env.seq : null,
    ts: typeof env.ts === "string" ? env.ts : null,
    type: typeof env.type === "string" ? env.type : null,
    actor: typeof env.actor === "string" ? env.actor : null,
    ...(typeof env.subject === "string" && env.subject ? { subject: env.subject } : {}),
    ...(typeof env.message === "string" && env.message ? { message: env.message } : {}),
  };
}

const recentEvents: ToolDefinition = {
  name: "recent_events",
  description:
    "Recent supervisor events for a city (or all cities), newest first. Filter by " +
    "`type` (e.g. session.crashed, bead.updated), `actor`, or `since` (Go duration, " +
    "e.g. 5m). Returns compact rows (seq, ts, type, actor, subject, message).",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "Limit to a single city; omit to fan out across all running cities." },
      type: { type: "string", description: "Filter by event type." },
      actor: { type: "string", description: "Filter by actor." },
      since: { type: "string", description: "Only events within this look-back window (Go duration)." },
      limit: { type: "number", description: "Max events to return overall (default 50)." },
    },
  },
  async handler(ctx, args) {
    const cityFilter = readString(args, "city");
    const type = readString(args, "type");
    const actor = readString(args, "actor");
    const since = readString(args, "since");
    const limit = readNumber(args, "limit") ?? 50;

    let cityNames: string[];
    if (cityFilter) {
      cityNames = [cityFilter];
    } else {
      const cities = await core.api.listCities(ctx.client);
      if (!cities.ok) return { data: errorData(cities.error), isError: true };
      cityNames = (cities.data.items ?? []).filter((c) => c.running).map((c) => c.name);
    }

    const query = {
      ...(type ? { type } : {}),
      ...(actor ? { actor } : {}),
      ...(since ? { since } : {}),
      limit,
    };

    const perCity = await Promise.all(
      cityNames.map(async (name) => {
        const res = await core.api.runApi(() =>
          ctx.client.GET("/v0/city/{cityName}/events", { params: { path: { cityName: name }, query } }),
        );
        if (!res.ok) return { city: name, error: res.error.title, events: [] as Array<Record<string, unknown>> };
        return { city: name, events: (res.data.items ?? []).map((env) => eventRow(name, env)) };
      }),
    );

    const errors = perCity.filter((c) => c.error).map((c) => ({ city: c.city, error: c.error as string }));
    const all = perCity.flatMap((c) => c.events);
    // Newest first across cities, then cap to the overall limit.
    all.sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")));
    const events = all.slice(0, limit);

    return {
      data: {
        count: all.length,
        ...(all.length > events.length ? { truncated: true, returned: events.length } : {}),
        ...(errors.length > 0 ? { partial: true, errors } : {}),
        events,
      },
    };
  },
};

// --- sling_bead (guarded write) --------------------------------------------

const slingBead: ToolDefinition = {
  name: "sling_bead",
  description:
    "Dispatch a bead to an agent or pool — optionally attaching a formula / launching " +
    "a workflow. This is the one mutating tool and is DISABLED by default: start the " +
    "server with --allow-writes (or GASCITY_MCP_ALLOW_WRITES=1) to enable it.",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "City the bead lives in." },
      target: { type: "string", description: "Target agent or pool, e.g. <rig>/gastown.polecat." },
      bead: { type: "string", description: "Bead id to sling (route an existing bead)." },
      formula: { type: "string", description: "Formula name to launch as a workflow." },
      rig: { type: "string", description: "Rig name, when scoping to a rig." },
      title: { type: "string", description: "Workflow title (formula launches)." },
      vars: { type: "object", description: "Formula variables (string → string).", additionalProperties: { type: "string" } },
      force: { type: "boolean", description: "Bypass cross-rig / missing-bead guards." },
    },
    required: ["city", "target"],
  },
  async handler(ctx, args) {
    if (!ctx.allowWrites) {
      return {
        data: {
          error: "writes disabled",
          detail: "The sling tool mutates the fleet. Restart mcp-gascity with --allow-writes (or GASCITY_MCP_ALLOW_WRITES=1) to enable it.",
        },
        isError: true,
      };
    }

    const city = readString(args, "city");
    const target = readString(args, "target");
    if (!city) return { data: { error: "city is required" }, isError: true };
    if (!target) return { data: { error: "target is required" }, isError: true };

    const input: core.api.SlingInput = { target };
    const bead = readString(args, "bead");
    if (bead) input.bead = bead;
    const formula = readString(args, "formula");
    if (formula) input.formula = formula;
    const rig = readString(args, "rig");
    if (rig) input.rig = rig;
    const title = readString(args, "title");
    if (title) input.title = title;
    const vars = readStringRecord(args, "vars");
    if (vars) input.vars = vars;
    const force = readBoolean(args, "force");
    if (force !== undefined) input.force = force;

    const beadsClient = new core.api.BeadsClient(ctx.client, city);
    const res = await beadsClient.sling(input);
    if (!res.ok) return { data: errorData(res.error), isError: true };
    return { data: { slung: res.data, city, target } };
  },
};

/** The full tool registry, in advertised order. */
export const TOOLS: readonly ToolDefinition[] = [
  fleetStatus,
  queryBeads,
  mergeQueue,
  telemetry,
  recentEvents,
  slingBead,
];

/** Look up a tool by name, or undefined when unknown. */
export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
