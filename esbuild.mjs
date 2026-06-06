// Bundles every Cockpit build target from its entry point.
//
//   - extension     the VS Code extension host (src/extension.ts). `vscode` is
//                   provided by the editor at runtime and stays external.
//   - fleet-status  a stub non-extension CLI (targets/cli) that imports the
//                   shared core boundary (src/core) and prints the fleet over
//                   /v0 — proof the core is consumable outside the editor.
//   - mcp-gascity   an MCP context server (targets/mcp) over stdio that exposes
//                   the fleet/beads/telemetry/merge-queue/events surface as MCP
//                   tools to any client (Zed, Copilot, Claude Code).
//   - web           the localhost read-only web companion (targets/web). A
//                   browser bundle (platform: browser) that imports the same
//                   src/core; its index.html + styles.css are copied beside the
//                   bundle so dist/web/ is a self-contained static bundle.
//
// A new sibling target (an ACP adapter next) adds one entry to `buildTargets`
// below and imports `src/core`; it does not reinvent the build (cockpit-dc8.4).
// A non-Node target overrides `platform`/`format`; static files to ship beside a
// bundle go in `assets`. See docs/core-boundary.md.
import esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** Per-target overrides, merged over `common`. `assets` is copied post-build, not an esbuild option. */
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
  {
    // MCP context server over stdio. No `vscode`; run by an MCP client as
    // `node dist/targets/mcp-gascity.js`.
    entryPoints: ["targets/mcp/main.ts"],
    outfile: "dist/targets/mcp-gascity.js",
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    // Browser companion. No `vscode`, no Node platform; bundles src/core for the
    // DOM and ships its HTML/CSS shell alongside (cockpit-dc8.7).
    entryPoints: ["targets/web/main.ts"],
    outfile: "dist/web/app.js",
    platform: "browser",
    format: "iife",
    assets: [
      ["targets/web/index.html", "dist/web/index.html"],
      ["targets/web/styles.css", "dist/web/styles.css"],
    ],
  },
];

/** Copy each target's static `assets` ([from, to] pairs) into dist/. */
async function copyAssets(targets) {
  for (const { assets = [] } of targets) {
    for (const [from, to] of assets) {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }
}

/** esbuild rejects unknown keys, so drop the build-script-only `assets` field. */
const esbuildOptions = buildTargets.map(({ assets: _assets, ...opts }) => opts);

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
  const ctxs = await Promise.all(esbuildOptions.map((t) => esbuild.context({ ...common, ...t })));
  await Promise.all(ctxs.map((c) => c.watch()));
  await copyAssets(buildTargets);
  console.log("[esbuild] watching…");
} else {
  await Promise.all(esbuildOptions.map((t) => esbuild.build({ ...common, ...t })));
  await copyAssets(buildTargets);
}
