// Architectural guard: the reusable core a non-VS-Code companion imports stays
// portable — free of `vscode` and of Node built-ins — so it runs unchanged in a
// browser or React Native runtime.
//
// This promotes the "vscode-free domain cores" guardrail
// (docs/contributing-features.md) from a convention to an enforced invariant,
// and de-risks the companion-surfaces spike (cockpit-21l.9, see
// docs/companion-surfaces.md). The whole premise of a web/mobile companion is
// that it shares the *same* typed `/v0` client and domain cores as the
// extension. If a future feature leaks `vscode` or a Node built-in into that
// surface, this test fails under `npm run check` — rather than the breakage
// surfacing only when someone first tries to build the companion.
//
// How it works: it walks the transitive *relative-import* closure of the
// barrels a companion consumes and asserts no reachable module imports a
// forbidden specifier. The editor-/host-bound modules (`src/status/views.ts`,
// the loopback-socket `src/extmsg/callback-server.ts`) are simply not reachable
// from these barrels, so they need no special-casing — the closure proves it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");

/**
 * The public barrels a web/mobile companion would import — the portable surface.
 * Each is intentionally `vscode`-free today (see its header comment); this test
 * makes that an enforced property of the whole transitive closure, not just the
 * barrel file.
 */
const PORTABLE_ENTRYPOINTS = [
  "api", // the typed /v0 client + SSE reader — the load-bearing shared layer
  "beads",
  "status", // status/views.ts (the VS Code adapter) is excluded by this barrel
  "town",
  "mergeQueue",
  "fleet",
  "formulas",
  "discovery",
  "cities",
  "code",
].map((name) => resolve(srcRoot, name, "index.ts"));

/** Node built-in modules — importing any of these breaks browser/RN portability. */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os",
  "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "timers", "tls", "trace_events", "tty", "url",
  "util", "v8", "vm", "worker_threads", "zlib",
]);

/** Classify a bare (non-relative) import specifier; returns a reason or null. */
function forbiddenReason(spec: string): string | null {
  if (spec === "vscode" || spec.startsWith("vscode/")) return "vscode";
  if (spec.startsWith("node:")) return spec;
  // Strip any subpath (e.g. "fs/promises") before checking the built-in name.
  const root = spec.split("/", 1)[0];
  if (NODE_BUILTINS.has(root)) return root;
  return null;
}

/** Strip line and block comments so a comment can never look like an import. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments, but not URL "://"
}

/** Extract every import/export/require/dynamic-import specifier from a module. */
function extractSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) specs.push(m[1]);
  return specs;
}

/** Resolve a relative specifier to an on-disk source file, or null if absent. */
function resolveLocal(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base, // explicit extension, e.g. "./types.ts"
    `${base}.ts`, // "./types" → "./types.ts"
    `${base}.d.ts`, // "./generated/v0" → "./generated/v0.d.ts"
    resolve(base, "index.ts"), // "./foo" → "./foo/index.ts"
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface ClosureResult {
  /** Every source file reachable from the entrypoints (excluding `.d.ts`). */
  visited: Set<string>;
  /** Reachable file → the forbidden specifiers it imports. */
  violations: Map<string, string[]>;
}

/** Walk the transitive relative-import closure from the given entrypoints. */
function importClosure(entrypoints: readonly string[]): ClosureResult {
  const visited = new Set<string>();
  const violations = new Map<string, string[]>();
  const queue = [...entrypoints];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const src = stripComments(readFileSync(file, "utf8"));
    const bad: string[] = [];
    for (const spec of extractSpecifiers(src)) {
      if (spec.startsWith(".")) {
        const resolved = resolveLocal(file, spec);
        // Pure-type `.d.ts` (generated types) carries no runtime import; skip it.
        if (resolved && !resolved.endsWith(".d.ts") && !visited.has(resolved)) {
          queue.push(resolved);
        }
        continue;
      }
      const reason = forbiddenReason(spec);
      if (reason) bad.push(reason);
    }
    if (bad.length > 0) violations.set(file, [...new Set(bad)]);
  }

  return { visited, violations };
}

const rel = (file: string): string => relative(srcRoot, file);

describe("reusable core is portable (companion-surfaces foundation)", () => {
  it("every portable entrypoint exists", () => {
    for (const entry of PORTABLE_ENTRYPOINTS) {
      expect(existsSync(entry), `missing entrypoint: ${rel(entry)}`).toBe(true);
    }
  });

  const closure = importClosure(PORTABLE_ENTRYPOINTS);

  it("walks a non-trivial closure (guards against a path bug passing vacuously)", () => {
    // The 10 entrypoint dirs hold dozens of modules; if the walk found only a
    // handful, resolution silently broke and the portability check is hollow.
    expect(closure.visited.size).toBeGreaterThan(30);
  });

  it("no reachable module imports `vscode` or a Node built-in", () => {
    const report = [...closure.violations.entries()]
      .map(([file, specs]) => `  ${rel(file)} → ${specs.join(", ")}`)
      .sort()
      .join("\n");
    expect(
      closure.violations.size,
      report &&
        `Non-portable imports reached from the companion's shared surface.\n` +
          `These break the web/mobile companion (cockpit-21l.9). Move the ` +
          `host-bound code into the editor glue (src/views, src/host) and keep ` +
          `the core free of vscode/Node built-ins:\n${report}`,
    ).toBe(0);
  });
});
