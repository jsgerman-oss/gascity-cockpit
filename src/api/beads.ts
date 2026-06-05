// Bead authoring domain layer over the typed /v0 client.
//
// This is the "domain store" seam from the PRD Testing Decisions (Seam 1): the
// ergonomic, provider-agnostic surface that feature code (the Beads explorer,
// command handlers) calls to create, mutate, route, and inspect beads. It owns
// three cross-cutting concerns the raw openapi-fetch client does not:
//
//   1. The required `X-GC-Request` anti-CSRF header on every mutation. The /v0
//      spec rejects mutating requests without it; the typed client enforces the
//      header at compile time, and this layer supplies it once.
//   2. Uniform error handling — every call resolves to a `BeadResult`, never
//      throws, mirroring `version.ts`'s `normalizeError` treatment so the UI has
//      one error shape to render.
//   3. Naming the bead domain model (the `Bead*`/`Sling*` aliases) so call sites
//      don't reach into the generated types.
//
// No `vscode` import — this is unit-testable against an OpenAPI-conformant mock
// /v0 server (PRD Testing Decisions, Seam 1).
import type { CockpitClient, NormalizedError } from "./client";
import { normalizeError } from "./client";
import type { Schema } from "./types";

// Domain model aliases. This module is the intended home for naming the bead
// shapes; downstream code imports these, not the generated schemas.

/** A bead as returned by the supervisor (list/get/create responses). */
export type Bead = Schema<"Bead">;
/** Request body for `create`. `title` is the only required field. */
export type BeadCreateInput = Schema<"BeadCreateInputBody">;
/** Request body for `update` — every field optional; provided fields are set. */
export type BeadUpdate = Schema<"BeadUpdateBody">;
/** The `deps` response — `{ children }`, the beads that depend on the target. */
export type BeadDeps = Schema<"BeadDepsResponse">;
/** A single dependency edge, as carried on `Bead.dependencies` (`type`d edge). */
export type BeadDep = Schema<"Dep">;
/** Request body for `sling` (the rich dispatch path). */
export type SlingInput = Schema<"SlingInputBody">;
/** Response from `sling` — target, mode, and any launched workflow id. */
export type SlingResult = Schema<"SlingResponse">;
/** `{ status }` acknowledgement returned by update/close/reopen. */
export type OkStatus = Schema<"OKResponseBody">;
/** The `assign` endpoint returns a string map (e.g. `{ assignee }`). */
export type AssignAck = { [key: string]: string };

/**
 * Uniform outcome of a bead operation: either typed `data`, or a normalized,
 * display-ready `error`. Operations never throw — network/abort rejections and
 * non-2xx problem documents both land in the `error` branch.
 */
export type BeadResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: NormalizedError };

/**
 * Value sent in the required `X-GC-Request` anti-CSRF header on every mutation.
 * The server only checks the header is present and non-empty; the value names
 * the Cockpit as the caller for server-side request logs.
 */
export const CSRF_HEADER_VALUE = "gascity-cockpit";

/**
 * Metadata key the supervisor's pool reconciler reads to route a bead to an
 * agent or pool. Setting it (see `route`) is the lightweight dispatch primitive.
 */
export const ROUTED_TO_KEY = "gc.routed_to";

/** The `{ data?, error?, response }` shape every openapi-fetch call resolves to. */
interface FetchOutcome<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Run one typed client call and fold it into a `BeadResult`. Handles both
 * failure modes openapi-fetch exposes: a returned `{ error }` for non-2xx
 * responses, and a thrown rejection for network/abort errors (which the client
 * lets propagate — see `version.ts`). The success `data` type is pinned by the
 * caller, which also type-checks that the endpoint returns what we expect.
 */
async function run<T>(call: () => Promise<FetchOutcome<T>>): Promise<BeadResult<T>> {
  let outcome: FetchOutcome<T>;
  try {
    outcome = await call();
  } catch (thrown) {
    return { ok: false, error: normalizeError(thrown) };
  }
  const { data, error, response } = outcome;
  if (error !== undefined || data === undefined) {
    return { ok: false, error: normalizeError(error, response) };
  }
  return { ok: true, data };
}

/**
 * Bead authoring + dispatch bound to a single city. The Cockpit is multi-city
 * (PRD User Story 35); construct one `BeadsClient` per selected city — it holds
 * only the shared typed client and the city name.
 */
export class BeadsClient {
  constructor(
    private readonly client: CockpitClient,
    /** City name interpolated into the `/v0/city/{cityName}/...` path. */
    readonly city: string,
  ) {}

  /** Header bag carrying the anti-CSRF token required on every mutation. */
  private get mutationHeader(): { "X-GC-Request": string } {
    return { "X-GC-Request": CSRF_HEADER_VALUE };
  }

  /** Create a bead. `input.title` is required; everything else is optional. */
  async create(input: BeadCreateInput): Promise<BeadResult<Bead>> {
    return run<Bead>(() =>
      this.client.POST("/v0/city/{cityName}/beads", {
        params: { path: { cityName: this.city }, header: this.mutationHeader },
        body: input,
      }),
    );
  }

  /**
   * Apply a partial update. Only the fields present in `patch` are changed;
   * `metadata` keys are merged (the /v0 contract sets the given keys rather than
   * replacing the whole map), so unrelated metadata is preserved.
   */
  async update(id: string, patch: BeadUpdate): Promise<BeadResult<OkStatus>> {
    return run<OkStatus>(() =>
      this.client.POST("/v0/city/{cityName}/bead/{id}/update", {
        params: { path: { cityName: this.city, id }, header: this.mutationHeader },
        body: patch,
      }),
    );
  }

  /** Close a bead (mark done). */
  async close(id: string): Promise<BeadResult<OkStatus>> {
    return run<OkStatus>(() =>
      this.client.POST("/v0/city/{cityName}/bead/{id}/close", {
        params: { path: { cityName: this.city, id }, header: this.mutationHeader },
      }),
    );
  }

  /** Reopen a previously closed bead. */
  async reopen(id: string): Promise<BeadResult<OkStatus>> {
    return run<OkStatus>(() =>
      this.client.POST("/v0/city/{cityName}/bead/{id}/reopen", {
        params: { path: { cityName: this.city, id }, header: this.mutationHeader },
      }),
    );
  }

  /** Assign a bead to an agent. Pass an empty string (or use `unassign`) to clear. */
  async assign(id: string, assignee: string): Promise<BeadResult<AssignAck>> {
    return run<AssignAck>(() =>
      this.client.POST("/v0/city/{cityName}/bead/{id}/assign", {
        params: { path: { cityName: this.city, id }, header: this.mutationHeader },
        body: { assignee },
      }),
    );
  }

  /** Clear a bead's assignee — convenience for assigning the empty string. */
  async unassign(id: string): Promise<BeadResult<AssignAck>> {
    return this.assign(id, "");
  }

  /** Read the beads that depend on this one (its dependency-tree children). */
  async deps(id: string): Promise<BeadResult<BeadDeps>> {
    return run<BeadDeps>(() =>
      this.client.GET("/v0/city/{cityName}/bead/{id}/deps", {
        params: { path: { cityName: this.city, id } },
      }),
    );
  }

  /**
   * Set or change a bead's parent — the one dependency edge the /v0 surface lets
   * you author (via the update `parent` field). Use `clearParent` to detach.
   *
   * NOTE: editing arbitrary `blocks`/`waits-for` edges is not yet exposed by /v0
   * (the `deps` endpoint is read-only). That gap is tracked against gastown, not
   * worked around here (PRD Out of Scope: API gaps are filed, not built).
   */
  async setParent(id: string, parent: string): Promise<BeadResult<OkStatus>> {
    return this.update(id, { parent });
  }

  /** Detach a bead from its parent. */
  async clearParent(id: string): Promise<BeadResult<OkStatus>> {
    return this.update(id, { parent: null });
  }

  /**
   * Route a bead to an agent or pool by setting the `gc.routed_to` metadata key
   * the reconciler reads. This is the lightweight dispatch primitive; reach for
   * `sling` when you need to attach a formula or launch a workflow. Metadata is
   * merged, so other keys on the bead are preserved.
   */
  async route(id: string, target: string): Promise<BeadResult<OkStatus>> {
    return this.update(id, { metadata: { [ROUTED_TO_KEY]: target } });
  }

  /**
   * Dispatch via the supervisor's sling: route a bead to a `target` agent/pool
   * and optionally attach a formula / launch a workflow. The richer counterpart
   * to `route` (PRD User Story 14).
   */
  async sling(input: SlingInput): Promise<BeadResult<SlingResult>> {
    return run<SlingResult>(() =>
      this.client.POST("/v0/city/{cityName}/sling", {
        params: { path: { cityName: this.city }, header: this.mutationHeader },
        body: input,
      }),
    );
  }
}
