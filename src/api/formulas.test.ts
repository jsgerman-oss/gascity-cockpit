import { describe, expect, it } from "vitest";
import { CSRF_HEADER_VALUE } from "./beads";
import { createCockpitClient } from "./client";
import {
  FormulasClient,
  type FormulaDetail,
  type FormulaList,
  type FormulaRuns,
} from "./formulas";
import { jsonResponse, mockFetch, problemResponse } from "../test/helpers";

const CITY = "blackrim-hq";

/** Build a FormulasClient wired to a mock fetch, exposing the recorded requests. */
function setup(handler: (req: Request) => Response | Promise<Response>) {
  const { fetch, calls } = mockFetch(handler);
  const client = createCockpitClient({ baseUrl: "http://api.test", fetch });
  return { formulas: new FormulasClient(client, CITY), calls };
}

/** Read the JSON body of a recorded request without disturbing the original. */
async function body(req: Request): Promise<unknown> {
  return req.clone().json();
}

const DETAIL: FormulaDetail = {
  name: "tdd",
  description: "Red-green-refactor on a bead",
  deps: [],
  steps: [
    { id: "red", kind: "step", title: "Write a failing test" },
    { id: "green", kind: "step", title: "Make it pass" },
  ],
  var_defs: [{ name: "bead", type: "string", required: true }],
  preview: {
    nodes: [
      { id: "red", kind: "step", title: "Write a failing test" },
      { id: "green", kind: "step", title: "Make it pass" },
    ],
    edges: [{ from: "red", to: "green", kind: "blocks" }],
  },
};

describe("FormulasClient.list", () => {
  it("GETs /formulas with no CSRF header and returns the list body", async () => {
    const list: FormulaList = {
      items: [{ name: "tdd", description: "TDD", recent_runs: [], run_count: 3, var_defs: [] }],
      partial: false,
      total: 1,
    };
    const { formulas, calls } = setup(() => jsonResponse(list));

    const result = await formulas.list();

    expect(result).toEqual({ ok: true, data: list, requestId: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/formulas`);
    expect(calls[0].headers.get("x-gc-request")).toBeNull();
  });

  it("threads scope_kind / scope_ref query params when scoped to a rig", async () => {
    const { formulas, calls } = setup(() => jsonResponse({ items: [], partial: false, total: 0 }));

    await formulas.list({ scopeKind: "rig", scopeRef: "gascity-cockpit" });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/v0/city/${CITY}/formulas`);
    expect(url.searchParams.get("scope_kind")).toBe("rig");
    expect(url.searchParams.get("scope_ref")).toBe("gascity-cockpit");
  });
});

describe("FormulasClient.get", () => {
  it("GETs /formulas/{name} with the required target query param", async () => {
    const { formulas, calls } = setup(() => jsonResponse(DETAIL));

    const result = await formulas.get("tdd", "gascity-cockpit/gastown.polecat");

    expect(result).toEqual({ ok: true, data: DETAIL, requestId: undefined });
    expect(calls[0].method).toBe("GET");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/v0/city/${CITY}/formulas/tdd`);
    expect(url.searchParams.get("target")).toBe("gascity-cockpit/gastown.polecat");
  });

  it("url-encodes the formula name in the path", async () => {
    const { formulas, calls } = setup(() => jsonResponse(DETAIL));
    await formulas.get("mol/work flow", "pool");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/formulas/mol%2Fwork%20flow`);
  });
});

describe("FormulasClient.preview", () => {
  it("POSTs the preview body to /preview with the CSRF header", async () => {
    const { formulas, calls } = setup(() => jsonResponse(DETAIL));

    const result = await formulas.preview("tdd", {
      target: "gascity-cockpit/gastown.polecat",
      vars: { bead: "blackrim-hq.42" },
    });

    expect(result).toEqual({ ok: true, data: DETAIL, requestId: undefined });
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/formulas/tdd/preview`);
    expect(calls[0].headers.get("x-gc-request")).toBe(CSRF_HEADER_VALUE);
    expect(await body(calls[0])).toEqual({
      target: "gascity-cockpit/gastown.polecat",
      vars: { bead: "blackrim-hq.42" },
    });
  });
});

describe("FormulasClient.runs", () => {
  it("GETs /runs and returns recent runs", async () => {
    const runs: FormulaRuns = {
      formula: "tdd",
      partial: false,
      run_count: 2,
      recent_runs: [
        {
          workflow_id: "wf-1",
          status: "running",
          target: "gascity-cockpit/gastown.polecat",
          started_at: "2026-06-05T00:00:00Z",
          updated_at: "2026-06-05T00:01:00Z",
        },
      ],
    };
    const { formulas, calls } = setup(() => jsonResponse(runs));

    const result = await formulas.runs("tdd", { limit: 5 });

    expect(result).toEqual({ ok: true, data: runs, requestId: undefined });
    expect(calls[0].method).toBe("GET");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/v0/city/${CITY}/formulas/tdd/runs`);
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("omits limit when not positive", async () => {
    const { formulas, calls } = setup(() =>
      jsonResponse({ formula: "tdd", partial: false, run_count: 0, recent_runs: [] }),
    );
    await formulas.runs("tdd", { limit: 0 });
    expect(new URL(calls[0].url).searchParams.has("limit")).toBe(false);
  });
});

describe("FormulasClient error handling", () => {
  it("folds an RFC 7807 problem document into ok:false with a normalized error", async () => {
    const problem = {
      type: "urn:gascity:error:formula-not-found",
      title: "Not Found",
      status: 404,
      detail: "formula nope does not exist",
    };
    const { formulas } = setup(() => problemResponse(problem, { status: 404 }));

    const result = await formulas.get("nope", "pool");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: 404,
        title: "Not Found",
        detail: "formula nope does not exist",
      });
    }
  });

  it("folds a network/abort rejection into ok:false instead of throwing", async () => {
    const { formulas } = setup(() => {
      throw new TypeError("fetch failed");
    });

    const result = await formulas.list();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.title).toBe("Network error");
      expect(result.error.status).toBe(0);
    }
  });
});
