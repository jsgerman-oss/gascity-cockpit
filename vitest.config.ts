import { defineConfig } from "vitest/config";

// Seam 1 (PRD Testing Decisions): the typed API-client layer is provider-agnostic
// and tested in plain Node — it never imports `vscode`, so no editor runtime is needed.
export default defineConfig({
  test: {
    // Cores live under src/; non-extension build targets (the CLI, future ACP/MCP
    // adapters) live under targets/ and carry their own tests.
    include: ["src/**/*.test.ts", "targets/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: [
        "src/api/**/*.ts",
        "src/cities/**/*.ts",
        "src/status/**/*.ts",
        "src/beads/**/*.ts",
        "src/code/**/*.ts",
        "src/formulas/**/*.ts",
        "src/telemetry/**/*.ts",
        "targets/**/*.ts",
      ],
      // Generated types and tests are excluded; the thin vscode-bound status
      // glue (views.ts) is intentionally not unit-tested (PRD); bead fixtures
      // are data-only and carry no logic worth covering.
      exclude: [
        "src/api/generated/**",
        "src/**/*.test.ts",
        "src/status/views.ts",
        "src/beads/fixtures.ts",
      ],
    },
  },
});
