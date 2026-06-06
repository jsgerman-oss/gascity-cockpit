// esbuild entry for the mcp-gascity target. Kept as a thin invocation shell so
// the logic in ./server.ts (and ./tools.ts / ./protocol.ts) stays side-effect-free
// and importable by tests without spawning a stdio server. esbuild bundles this
// to dist/targets/mcp-gascity.js with a `#!/usr/bin/env node` banner.
import { run } from "./server.ts";

void run(process.argv.slice(2), process.env).then((code) => {
  process.exitCode = code;
});
