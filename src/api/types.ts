// Friendly re-exports over the auto-generated OpenAPI types.
//
// Downstream code should import domain shapes from here (or from the package
// barrel) rather than reaching into `generated/v0` directly, so the generated
// file stays an implementation detail that can be regenerated freely.
import type { components, paths, operations } from "./generated/v0";

export type { components, paths, operations };

/** All response/request schemas defined by the /v0 OpenAPI spec. */
export type Schemas = components["schemas"];

/**
 * Look up a single generated schema by name, e.g. `Schema<"ListBodyBead">`.
 * Keeps call sites readable without importing `components` everywhere.
 */
export type Schema<K extends keyof Schemas> = Schemas[K];

// A few high-traffic shapes promoted to named aliases. Add more here as the
// downstream feature beads (beads explorer, status panes, chat) need them —
// this is the intended seam for naming the /v0 domain model.

/** `GET /health` body — supervisor liveness, version, and startup phase. */
export type SupervisorHealth = Schema<"SupervisorHealthOutputBody">;

/** RFC 7807 problem document returned on error responses. */
export type ApiErrorModel = Schema<"ErrorModel">;
