import { describe, expect, it } from "vitest";
import { COLOR_THEME_KIND, buildTheme, resolveDashboardUrl, themeKindFrom } from "./config";

describe("resolveDashboardUrl", () => {
  it("treats empty / whitespace / nullish as unset (not an error)", () => {
    expect(resolveDashboardUrl("")).toEqual({ status: "unset" });
    expect(resolveDashboardUrl("   ")).toEqual({ status: "unset" });
    expect(resolveDashboardUrl(null)).toEqual({ status: "unset" });
    expect(resolveDashboardUrl(undefined)).toEqual({ status: "unset" });
  });

  it("accepts http(s) and derives the origin", () => {
    const r = resolveDashboardUrl("http://127.0.0.1:5173");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.origin).toBe("http://127.0.0.1:5173");
      expect(r.url).toBe("http://127.0.0.1:5173/");
    }
  });

  it("origin strips the path/query but keeps host+port", () => {
    const r = resolveDashboardUrl("https://dash.example:8443/app?city=hq");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.origin).toBe("https://dash.example:8443");
  });

  it("rejects non-http(s) schemes and garbage", () => {
    expect(resolveDashboardUrl("ftp://h/x").status).toBe("invalid");
    expect(resolveDashboardUrl("file:///etc/passwd").status).toBe("invalid");
    expect(resolveDashboardUrl("vscode-webview://x").status).toBe("invalid");
    expect(resolveDashboardUrl("not a url").status).toBe("invalid");
  });
});

describe("themeKindFrom", () => {
  it("maps VS Code ColorThemeKind values to contract kinds", () => {
    expect(themeKindFrom(COLOR_THEME_KIND.Light)).toBe("light");
    expect(themeKindFrom(COLOR_THEME_KIND.Dark)).toBe("dark");
    expect(themeKindFrom(COLOR_THEME_KIND.HighContrast)).toBe("high-contrast");
    expect(themeKindFrom(COLOR_THEME_KIND.HighContrastLight)).toBe("high-contrast-light");
  });

  it("falls back to dark for unknown values", () => {
    expect(themeKindFrom(99)).toBe("dark");
  });
});

describe("buildTheme", () => {
  it("includes a trimmed name when present and omits an empty one", () => {
    expect(buildTheme(COLOR_THEME_KIND.Dark, "  Default Dark Modern  ")).toEqual({
      kind: "dark",
      name: "Default Dark Modern",
    });
    expect(buildTheme(COLOR_THEME_KIND.Light, "   ")).toEqual({ kind: "light" });
    expect(buildTheme(COLOR_THEME_KIND.Light)).toEqual({ kind: "light" });
  });
});
