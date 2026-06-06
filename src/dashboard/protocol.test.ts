import { describe, expect, it } from "vitest";
import {
  DASHBOARD_ERROR,
  DASHBOARD_NAVIGATE_NATIVE,
  DASHBOARD_OPEN_EXTERNAL,
  DASHBOARD_READY,
  DASHBOARD_ROUTE_CHANGED,
  EMBED_CHANNEL,
  EMBED_PROTOCOL_VERSION,
  HOST_API,
  HOST_CONFIG,
  HOST_NAVIGATE,
  HOST_THEME,
  isEmbedMessage,
  parseDashboardMessage,
  parseHostMessage,
} from "./protocol";

function envelope(type: string, extra: Record<string, unknown> = {}) {
  return { channel: EMBED_CHANNEL, protocol: EMBED_PROTOCOL_VERSION, type, ...extra };
}

describe("isEmbedMessage", () => {
  it("accepts a well-formed envelope on our channel", () => {
    expect(isEmbedMessage(envelope(DASHBOARD_READY))).toBe(true);
  });

  it("rejects non-objects and wrong/missing fields", () => {
    expect(isEmbedMessage(null)).toBe(false);
    expect(isEmbedMessage("ready")).toBe(false);
    expect(isEmbedMessage([])).toBe(false);
    expect(isEmbedMessage({ protocol: 1, type: "x" })).toBe(false); // no channel
    expect(isEmbedMessage({ channel: "other", protocol: 1, type: "x" })).toBe(false);
    expect(isEmbedMessage({ channel: EMBED_CHANNEL, type: "x" })).toBe(false); // no protocol
    expect(isEmbedMessage({ channel: EMBED_CHANNEL, protocol: 1, type: "" })).toBe(false); // empty type
  });
});

describe("parseDashboardMessage", () => {
  it("parses dashboard/ready", () => {
    const msg = parseDashboardMessage(envelope(DASHBOARD_READY));
    expect(msg).toEqual({
      channel: EMBED_CHANNEL,
      protocol: EMBED_PROTOCOL_VERSION,
      type: DASHBOARD_READY,
    });
  });

  it("parses navigate-native and validates the target", () => {
    const ok = parseDashboardMessage(
      envelope(DASHBOARD_NAVIGATE_NATIVE, { target: { kind: "bead", id: "cockpit-1ll.10", city: "hq" } }),
    );
    expect(ok?.type).toBe(DASHBOARD_NAVIGATE_NATIVE);
    if (ok?.type === DASHBOARD_NAVIGATE_NATIVE) {
      expect(ok.target).toEqual({ kind: "bead", id: "cockpit-1ll.10", city: "hq" });
    }
    // Bad kind / missing id are rejected.
    expect(parseDashboardMessage(envelope(DASHBOARD_NAVIGATE_NATIVE, { target: { kind: "nope", id: "x" } }))).toBeNull();
    expect(parseDashboardMessage(envelope(DASHBOARD_NAVIGATE_NATIVE, { target: { kind: "bead" } }))).toBeNull();
    expect(parseDashboardMessage(envelope(DASHBOARD_NAVIGATE_NATIVE, {}))).toBeNull();
  });

  it("parses open-external and requires a non-empty url", () => {
    const ok = parseDashboardMessage(envelope(DASHBOARD_OPEN_EXTERNAL, { url: "https://example.test" }));
    expect(ok?.type).toBe(DASHBOARD_OPEN_EXTERNAL);
    expect(parseDashboardMessage(envelope(DASHBOARD_OPEN_EXTERNAL, { url: "" }))).toBeNull();
    expect(parseDashboardMessage(envelope(DASHBOARD_OPEN_EXTERNAL, {}))).toBeNull();
  });

  it("parses route-changed including a string-valued query", () => {
    const ok = parseDashboardMessage(
      envelope(DASHBOARD_ROUTE_CHANGED, { route: { city: "hq", view: "agents", query: { id: "7" } } }),
    );
    expect(ok?.type).toBe(DASHBOARD_ROUTE_CHANGED);
    // A non-string query value invalidates the route.
    expect(
      parseDashboardMessage(envelope(DASHBOARD_ROUTE_CHANGED, { route: { query: { n: 7 } } })),
    ).toBeNull();
  });

  it("parses error and treats detail as optional", () => {
    expect(parseDashboardMessage(envelope(DASHBOARD_ERROR, { message: "boom" }))?.type).toBe(DASHBOARD_ERROR);
    const withDetail = parseDashboardMessage(envelope(DASHBOARD_ERROR, { message: "boom", detail: "stack" }));
    if (withDetail?.type === DASHBOARD_ERROR) expect(withDetail.detail).toBe("stack");
    expect(parseDashboardMessage(envelope(DASHBOARD_ERROR, {}))).toBeNull();
    expect(parseDashboardMessage(envelope(DASHBOARD_ERROR, { message: "x", detail: 1 }))).toBeNull();
  });

  it("rejects unknown types, host messages, and the wrong channel", () => {
    expect(parseDashboardMessage(envelope("dashboard/unknown"))).toBeNull();
    expect(parseDashboardMessage(envelope(HOST_CONFIG, { config: {} }))).toBeNull();
    expect(
      parseDashboardMessage({ channel: "other", protocol: 1, type: DASHBOARD_READY }),
    ).toBeNull();
  });

  it("rejects malformed routes (non-object or non-string city/view/path)", () => {
    const bad = (route: unknown) => parseDashboardMessage(envelope(DASHBOARD_ROUTE_CHANGED, { route }));
    expect(bad("nope")).toBeNull(); // route not an object
    expect(bad({ city: 7 })).toBeNull(); // city not a string
    expect(bad({ view: 7 })).toBeNull(); // view not a string
    expect(bad({ path: 7 })).toBeNull(); // path not a string
    // A route carrying a valid path is accepted (covers the happy path arm).
    const ok = parseDashboardMessage(envelope(DASHBOARD_ROUTE_CHANGED, { route: { path: "/agents" } }));
    if (ok?.type === DASHBOARD_ROUTE_CHANGED) expect(ok.route.path).toBe("/agents");
  });

  it("rejects a navigate-native target with a non-string city", () => {
    expect(
      parseDashboardMessage(envelope(DASHBOARD_NAVIGATE_NATIVE, { target: { kind: "bead", id: "x", city: 7 } })),
    ).toBeNull();
  });
});

describe("parseHostMessage", () => {
  const theme = { kind: "dark" as const };
  const api = { baseUrl: "http://127.0.0.1:8372", token: null };
  const capabilities = { canOpenNative: true, canOpenExternal: true };

  it("parses a full host/config", () => {
    const config = { protocol: EMBED_PROTOCOL_VERSION, api, theme, capabilities, city: "hq" };
    const ok = parseHostMessage(envelope(HOST_CONFIG, { config }));
    expect(ok?.type).toBe(HOST_CONFIG);
    if (ok?.type === HOST_CONFIG) {
      expect(ok.config.api.baseUrl).toBe("http://127.0.0.1:8372");
      expect(ok.config.city).toBe("hq");
    }
  });

  it("rejects a config missing api / theme / capabilities", () => {
    expect(parseHostMessage(envelope(HOST_CONFIG, { config: { protocol: 1, theme, capabilities } }))).toBeNull();
    expect(parseHostMessage(envelope(HOST_CONFIG, { config: { protocol: 1, api, capabilities } }))).toBeNull();
    expect(parseHostMessage(envelope(HOST_CONFIG, { config: { protocol: 1, api, theme } }))).toBeNull();
  });

  it("parses host/theme and rejects an unknown kind", () => {
    expect(parseHostMessage(envelope(HOST_THEME, { theme: { kind: "dark" } }))?.type).toBe(HOST_THEME);
    expect(parseHostMessage(envelope(HOST_THEME, { theme: { kind: "neon" } }))).toBeNull();
  });

  it("parses host/navigate and host/api", () => {
    expect(parseHostMessage(envelope(HOST_NAVIGATE, { route: { city: "hq" } }))?.type).toBe(HOST_NAVIGATE);
    const apiMsg = parseHostMessage(envelope(HOST_API, { api: { baseUrl: "http://h:1", token: "t" } }));
    expect(apiMsg?.type).toBe(HOST_API);
    expect(parseHostMessage(envelope(HOST_API, { api: { token: "t" } }))).toBeNull(); // no baseUrl
  });

  it("rejects non-embed input, unknown host types, and an invalid navigate route", () => {
    expect(parseHostMessage(null)).toBeNull(); // not an embed message at all
    expect(parseHostMessage({ channel: "other", protocol: 1, type: HOST_CONFIG })).toBeNull(); // wrong channel
    expect(parseHostMessage(envelope("host/unknown"))).toBeNull(); // unrecognised type (default arm)
    expect(parseHostMessage(envelope(HOST_NAVIGATE, { route: "bad" }))).toBeNull(); // route fails to parse
  });

  it("accepts a theme with name + tokens and rejects malformed ones", () => {
    const ok = parseHostMessage(
      envelope(HOST_THEME, { theme: { kind: "dark", name: "Default Dark", tokens: { foreground: "#fff" } } }),
    );
    expect(ok?.type).toBe(HOST_THEME);
    if (ok?.type === HOST_THEME) {
      expect(ok.theme.name).toBe("Default Dark");
      expect(ok.theme.tokens).toEqual({ foreground: "#fff" });
    }
    expect(parseHostMessage(envelope(HOST_THEME, { theme: { kind: "dark", name: 5 } }))).toBeNull();
    expect(parseHostMessage(envelope(HOST_THEME, { theme: { kind: "dark", tokens: { a: 1 } } }))).toBeNull();
  });

  it("rejects an api access with a non-string, non-null token", () => {
    expect(parseHostMessage(envelope(HOST_API, { api: { baseUrl: "http://h:1", token: 5 } }))).toBeNull();
  });

  it("rejects configs with a bad protocol, capabilities, city, or route", () => {
    const base = { protocol: EMBED_PROTOCOL_VERSION, api, theme, capabilities };
    const cfg = (over: Record<string, unknown>) =>
      parseHostMessage(envelope(HOST_CONFIG, { config: { ...base, ...over } }));
    expect(cfg({ protocol: "1" })).toBeNull(); // protocol not a number
    expect(cfg({ capabilities: { canOpenNative: "yes", canOpenExternal: true } })).toBeNull(); // caps not boolean
    expect(cfg({ city: 7 })).toBeNull(); // city not a string
    expect(cfg({ route: "bad" })).toBeNull(); // route fails to parse
    const ok = cfg({ route: { city: "hq", view: "agents" } }); // a valid embedded route is accepted
    expect(ok?.type).toBe(HOST_CONFIG);
    if (ok?.type === HOST_CONFIG) expect(ok.config.route).toEqual({ city: "hq", view: "agents" });
  });
});
