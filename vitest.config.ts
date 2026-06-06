import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Seam 1 (PRD Testing Decisions): the typed API-client layer is provider-agnostic
// and tested in plain Node — it never imports `vscode`, so no editor runtime is needed.
export default defineConfig({
  test: {
    // Cores live under src/; non-extension build targets (the CLI, future ACP/MCP
    // adapters) live under targets/ and carry their own tests.
    include: ["src/**/*.test.ts", "targets/**/*.test.ts"],
    environment: "node",
    // There is no `vscode` runtime in node_modules (only `@types/vscode`), so the
    // host-abstracted features — which reach `vscode` transitively through their
    // `src/views/` glue — could not be imported in a Node test. Redirect the bare
    // `vscode` specifier to the in-memory fake (src/test/fake-vscode.ts) so a
    // feature's register() runs and is drivable via src/test/fake-host.ts. Exact
    // match only (`/^vscode$/`) so any `vscode/...` subpath is left untouched. This
    // is a runtime alias for the test run; tsc still resolves `vscode` to the real
    // types, and the portability guard (core-portability.test.ts) reads source text
    // rather than importing, so it is unaffected.
    alias: [
      {
        find: /^vscode$/,
        replacement: fileURLToPath(new URL("./src/test/fake-vscode.ts", import.meta.url)),
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov"],
      // Count every accessible source file, even those no test imports yet, so
      // the report shows the true surface (uncovered files appear at 0%).
      all: true,
      include: ["src/**/*.ts", "targets/**/*.ts"],
      // Two kinds of exclusion only:
      //  (1) nothing to cover — generated client, tests, type-only decls,
      //      barrels (re-exports), and data fixtures/test helpers.
      //  (2) genuinely editor-bound — files that import `vscode` and so need a
      //      real VS Code runtime (tree/webview providers, the panels, the host
      //      impl, the activation entry, and the 5 features that call vscode
      //      directly). Everything host-abstracted stays IN: the api/domain
      //      cores, the chat conversation-store/protocol/html, and the 12
      //      features that depend on the `host` interface, not `vscode`.
      exclude: [
        "src/api/generated/**",
        "src/**/*.test.ts",
        "src/**/types.ts",
        "src/**/index.ts",
        "src/**/fixtures.ts",
        "src/test/**",
        "src/extension.ts",
        "src/views/**",
        "src/host/host.ts",
        "src/status/views.ts",
        "src/chat/chat-panel.ts",
        "src/chat/open-chat.ts",
        "src/dashboard/panel.ts",
        "src/features/chat.feature.ts",
        "src/features/chatParticipant.feature.ts",
        "src/features/dashboard.feature.ts",
        "src/features/extmsg.feature.ts",
        "src/features/notifications.feature.ts",
      ],
      // Target gate (≥95 everywhere testable). NOT yet wired into `npm run
      // check` — flip on after the fill phase brings cores to green, so
      // in-flight PRs aren't blocked meanwhile.
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
});
