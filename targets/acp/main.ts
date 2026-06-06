// esbuild entry for the acp-mayor target. Kept as a thin invocation shell so the
// logic in ./acp-mayor.ts stays a side-effect-free library that tests import
// without touching `process` streams. esbuild bundles this to
// dist/targets/acp-mayor.js with a `#!/usr/bin/env node` banner.
import { run } from "./acp-mayor.ts";

void run(process.argv.slice(2), process.env).then((code) => {
  process.exitCode = code;
});
