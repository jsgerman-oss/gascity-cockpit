// The portable Cockpit core — the single boundary a non-extension target imports.
//
// "Core" is the `vscode`-free, Node-built-in-free half of the Cockpit: the typed
// `/v0` client (sessions, approvals, beads, formulas, SSE) plus every domain
// core (bead derivation, telemetry, merge-queue, fleet queries, town topology,
// discovery, city presentation, worktree code lenses). The companion-surfaces
// spike (cockpit-21l.9, docs/companion-surfaces.md) proved this surface is
// browser/React-Native-portable; this barrel turns that proven surface into one
// importable boundary so sibling **targets** — a CLI today (`targets/cli`); an
// ACP adapter, MCP server, or web companion next — consume it without reaching
// into individual modules or reinventing the build. See docs/core-boundary.md.
//
// Re-exported as **namespaces** (`core.api`, `core.fleet`, …) rather than
// flattened: the barrels have intentional name overlaps (e.g. both `api` and
// `discovery` export `normalizeBaseUrl`), so a flat `export *` would silently
// drop the collisions. Namespacing keeps every symbol reachable and makes the
// boundary self-documenting at the call site.
//
// Portability is enforced, not just intended: src/test/core-portability.test.ts
// walks this barrel's transitive relative-import closure and fails
// `npm run check` if any reachable module imports `vscode` or a Node built-in —
// so the boundary cannot silently rot as features land.

// The load-bearing shared layer: the typed `/v0` client + SSE readers, and the
// sessions / approvals / beads / formulas / extmsg domain calls built on it.
export * as api from "../api/index.ts";

// Domain cores the bead names explicitly (beads / telemetry / mergeQueue) …
export * as beads from "../beads/index.ts";
export * as telemetry from "../telemetry/index.ts";
export * as mergeQueue from "../mergeQueue/index.ts";

// … and the rest of the portable surface the companion-surfaces audit identified.
export * as fleet from "../fleet/index.ts";
export * as status from "../status/index.ts";
export * as town from "../town/index.ts";
export * as formulas from "../formulas/index.ts";
export * as discovery from "../discovery/index.ts";
export * as cities from "../cities/index.ts";
export * as code from "../code/index.ts";
