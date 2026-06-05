// Formula domain layer over the typed /v0 client (PRD user stories 30–31).
//
// The Seam-1 "domain store" for formulas: the ergonomic, provider-agnostic
// surface the TDD / workflow affordances call to list formulas, preview a
// compiled formula, and watch its runs. Like `beads.ts` it owns the cross-cutting
// concerns the raw openapi-fetch client does not:
//
//   1. The required `X-GC-Request` anti-CSRF header on the one mutating call
//      (`preview`, a POST). The typed client enforces the header at compile time;
//      this layer supplies it once.
//   2. Uniform error handling — every call resolves to an `ApiResult`, never
//      throws (via the shared `runApi` helper), so the UI has one error shape.
//   3. Naming the formula domain model (the `Formula*` aliases) so call sites do
//      not reach into the generated schemas.
//
// "Running" a formula on a bead is not a formula endpoint — it is a dispatch, so
// it lives on `BeadsClient.sling` (with `formula`/`vars`). This client is the
// read + preview surface; the glue wires sling to it for the "kick off TDD" flow.
//
// No `vscode` import — unit-testable against an OpenAPI-conformant mock /v0
// server (PRD Testing Decisions, Seam 1).
// The anti-CSRF caller-name sent on mutations is shared across the Cockpit's
// mutation clients; `beads.ts` is its single source of truth (re-defining it
// here would collide under the `./index` barrel's `export *`).
import { CSRF_HEADER_VALUE } from "./beads";
import type { CockpitClient } from "./client";
import { runApi, type ApiResult } from "./result";
import type { Schema } from "./types";

// Domain model aliases — the intended home for naming the formula shapes.

/** A formula summary as returned by the list endpoint. */
export type FormulaSummary = Schema<"FormulaSummaryResponse">;
/** `GET .../formulas` envelope — `{ items, partial, total }`. */
export type FormulaList = Schema<"FormulaListBody">;
/** Full formula detail: steps, variable defs, and a compiled preview DAG. */
export type FormulaDetail = Schema<"FormulaDetailResponse">;
/** Request body for `preview` — `target` is required; `vars` override defaults. */
export type FormulaPreviewInput = Schema<"FormulaPreviewBody">;
/** `GET .../formulas/{name}/runs` envelope — recent workflow runs of a formula. */
export type FormulaRuns = Schema<"FormulaRunsResponse">;
/** A single recent run (workflow id, status, target, timestamps). */
export type FormulaRun = Schema<"FormulaRecentRunResponse">;
/** One compiled step in a formula (id, kind, title, optional assignee/labels). */
export type FormulaStep = Schema<"FormulaStepResponse">;
/** A formula variable definition (name, type, default, enum, required). */
export type FormulaVarDef = Schema<"FormulaVarDefResponse">;
/** The compiled preview graph — `{ nodes, edges }`. */
export type FormulaPreview = Schema<"FormulaPreviewResponse">;
/** A node in the compiled preview graph. */
export type FormulaPreviewNode = Schema<"FormulaPreviewNodeResponse">;
/** An edge in the compiled preview graph. */
export type FormulaPreviewEdge = Schema<"FormulaPreviewEdgeResponse">;

/**
 * Optional formula scope. A city has city-scoped formulas plus the formulas of
 * each rig; `scopeKind: "rig"` + `scopeRef: "<rig>"` selects a rig's formula
 * when a name is ambiguous across scopes.
 */
export interface FormulaScope {
  /** Scope kind: `"city"` (default) or `"rig"`. */
  scopeKind?: string;
  /** Scope reference, e.g. the rig name when `scopeKind` is `"rig"`. */
  scopeRef?: string;
}

/** Map a `FormulaScope` to the generated `{ scope_kind?, scope_ref? }` query. */
function scopeQuery(scope: FormulaScope): { scope_kind?: string; scope_ref?: string } {
  const query: { scope_kind?: string; scope_ref?: string } = {};
  if (scope.scopeKind) query.scope_kind = scope.scopeKind;
  if (scope.scopeRef) query.scope_ref = scope.scopeRef;
  return query;
}

/**
 * Formula list / preview / runs bound to a single city. The Cockpit is
 * multi-city (PRD User Story 35); construct one `FormulasClient` per selected
 * city — it holds only the shared typed client and the city name.
 */
export class FormulasClient {
  constructor(
    private readonly client: CockpitClient,
    /** City name interpolated into the `/v0/city/{cityName}/...` path. */
    readonly city: string,
  ) {}

  /** Header bag carrying the anti-CSRF token required on the `preview` mutation. */
  private get mutationHeader(): { "X-GC-Request": string } {
    return { "X-GC-Request": CSRF_HEADER_VALUE };
  }

  /** List the formulas available in this city (optionally scoped to a rig). */
  async list(scope: FormulaScope = {}): Promise<ApiResult<FormulaList>> {
    return runApi<FormulaList>(() =>
      this.client.GET("/v0/city/{cityName}/formulas", {
        params: { path: { cityName: this.city }, query: scopeQuery(scope) },
      }),
    );
  }

  /**
   * Full detail for one formula, compiled for `target` (the agent/pool the
   * preview DAG is rendered against — required by the /v0 contract).
   */
  async get(name: string, target: string, scope: FormulaScope = {}): Promise<ApiResult<FormulaDetail>> {
    return runApi<FormulaDetail>(() =>
      this.client.GET("/v0/city/{cityName}/formulas/{name}", {
        params: { path: { cityName: this.city, name }, query: { target, ...scopeQuery(scope) } },
      }),
    );
  }

  /**
   * Preview a formula compiled for a target, with optional variable overrides.
   * Returns the same detail shape as `get`, but driven by an explicit request
   * body — the path the TDD affordance uses to show the operator the steps and
   * DAG before committing to a run.
   */
  async preview(name: string, input: FormulaPreviewInput): Promise<ApiResult<FormulaDetail>> {
    return runApi<FormulaDetail>(() =>
      this.client.POST("/v0/city/{cityName}/formulas/{name}/preview", {
        params: { path: { cityName: this.city, name }, header: this.mutationHeader },
        body: input,
      }),
    );
  }

  /**
   * Recent runs of a formula — the "watch its runs" surface. `limit` caps the
   * number of recent runs (0/omitted uses the server default).
   */
  async runs(name: string, opts: { limit?: number } & FormulaScope = {}): Promise<ApiResult<FormulaRuns>> {
    const query: { scope_kind?: string; scope_ref?: string; limit?: number } = scopeQuery(opts);
    if (opts.limit && opts.limit > 0) query.limit = opts.limit;
    return runApi<FormulaRuns>(() =>
      this.client.GET("/v0/city/{cityName}/formulas/{name}/runs", {
        params: { path: { cityName: this.city, name }, query },
      }),
    );
  }
}
