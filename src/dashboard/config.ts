// Dashboard projection configuration: resolve/validate the operator-supplied
// dashboard URL and map the VS Code color theme to the contract's theme shape.
//
// The dashboard to project is "forthcoming" (does not exist yet), so everything
// here is driven by a CONFIGURABLE URL (the `gascityCockpit.dashboard.url`
// setting) with a graceful unset/invalid path — we do not hard-code any
// dashboard internals (PRD Out of Scope). Provider-agnostic (no `vscode`
// import): the theme mapping takes a plain numeric kind so it is unit-testable.
import type { DashboardTheme, ThemeKind } from "./protocol";

/** Outcome of resolving the configured dashboard URL. */
export type DashboardUrlResolution =
  /** A usable http(s) URL; `origin` drives CSP `frame-src` and postMessage pinning. */
  | { status: "ok"; url: string; origin: string }
  /** No URL configured yet — show the configure placeholder, not an error. */
  | { status: "unset" }
  /** A URL was configured but is unusable; `reason` explains why. */
  | { status: "invalid"; reason: string };

/**
 * Validate the configured dashboard URL. Empty/whitespace is `unset` (expected
 * until a real dashboard lands); anything present must be a well-formed http(s)
 * URL — other schemes (`file:`, `vscode-webview:`) cannot be safely framed.
 */
export function resolveDashboardUrl(raw: string | null | undefined): DashboardUrlResolution {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { status: "unset" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { status: "invalid", reason: `Not a valid URL: "${trimmed}".` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      status: "invalid",
      reason: `Dashboard URL must use http or https (got "${parsed.protocol}").`,
    };
  }
  return { status: "ok", url: parsed.toString(), origin: parsed.origin };
}

/**
 * Mirror of VS Code's `ColorThemeKind` numeric enum. Duplicated (not imported)
 * so the mapping stays free of the `vscode` module and unit-testable in Node.
 */
export const COLOR_THEME_KIND = {
  Light: 1,
  Dark: 2,
  HighContrast: 3,
  HighContrastLight: 4,
} as const;

/** Map a VS Code `ColorThemeKind` value to the contract's coarse theme kind. */
export function themeKindFrom(kind: number): ThemeKind {
  switch (kind) {
    case COLOR_THEME_KIND.Light:
      return "light";
    case COLOR_THEME_KIND.HighContrast:
      return "high-contrast";
    case COLOR_THEME_KIND.HighContrastLight:
      return "high-contrast-light";
    case COLOR_THEME_KIND.Dark:
    default:
      return "dark";
  }
}

/**
 * Build the host-known part of the theme (kind + active theme name). High-fidelity
 * `tokens` are filled in by the shell, which alone can read the resolved
 * `--vscode-*` variables; this is the coarse snapshot good enough for first paint.
 */
export function buildTheme(kind: number, name?: string): DashboardTheme {
  const theme: DashboardTheme = { kind: themeKindFrom(kind) };
  if (name && name.trim()) theme.name = name.trim();
  return theme;
}
