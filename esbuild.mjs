// Bundles every Cockpit build target from its entry point.
//
//   - extension     the VS Code extension host (src/extension.ts). `vscode` is
//                   provided by the editor at runtime and stays external.
//   - fleet-status  a stub non-extension CLI (targets/cli) that imports the
//                   shared core boundary (src/core) and prints the fleet over
//                   /v0 — proof the core is consumable outside the editor.
//
// A new sibling target (ACP adapter, MCP server, web companion) adds one entry
// to `buildTargets` below and imports `src/core`; it does not reinvent the build
// (cockpit-dc8.4). See docs/core-boundary.md.
import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** Per-target overrides, merged over `common`. */
const buildTargets = [
  {
    // The extension host, loaded by VS Code via package.json `main`.
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    external: ["vscode"],
  },
  {
    // Non-extension CLI. No `vscode`; runnable with `node dist/targets/fleet-status.js`.
    entryPoints: ["targets/cli/main.ts"],
    outfile: "dist/targets/fleet-status.js",
    banner: { js: "#!/usr/bin/env node" },
  },
];

/** Settings shared by every target. */
const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (watch) {
  const ctxs = await Promise.all(buildTargets.map((t) => esbuild.context({ ...common, ...t })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("[esbuild] watching…");
} else {
  await Promise.all(buildTargets.map((t) => esbuild.build({ ...common, ...t })));
}
