import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "out/**",
      "node_modules/**",
      ".vscode-test/**",
      // Generated from the OpenAPI spec — not hand-maintained.
      "src/api/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Node-run build/generate scripts and flat-config files.
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
      },
    },
  },
);
