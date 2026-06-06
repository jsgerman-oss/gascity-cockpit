// esbuild entry for the fleet-status CLI target. Kept as a thin invocation shell
// so the logic in ./fleet-status.ts stays a side-effect-free library that tests
// can import without spawning network calls. esbuild bundles this to
// dist/targets/fleet-status.js with a `#!/usr/bin/env node` banner.
import { run } from "./fleet-status.ts";

void run(process.argv.slice(2), process.env).then((code) => {
  process.exitCode = code;
});
