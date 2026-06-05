import { describe, expect, it } from "vitest";
import {
  DashboardBridge,
  apiMessage,
  buildConfig,
  configMessage,
  navigateMessage,
  themeMessage,
  type BridgeLogLevel,
  type DashboardHandlers,
} from "./bridge";
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
  type HostMessage,
} from "./protocol";

const THEME = { kind: "dark" as const };
const API = { baseUrl: "http://127.0.0.1:8372", token: null };

function envelope(type: string, extra: Record<string, unknown> = {}) {
  return { channel: EMBED_CHANNEL, protocol: EMBED_PROTOCOL_VERSION, type, ...extra };
}

describe("outbound message builders", () => {
  it("configMessage stamps the envelope from the config protocol", () => {
    const config = buildConfig({ api: API, theme: THEME });
    expect(configMessage(config)).toEqual({
      channel: EMBED_CHANNEL,
      protocol: EMBED_PROTOCOL_VERSION,
      type: HOST_CONFIG,
      config,
    });
  });

  it("themeMessage / navigateMessage / apiMessage default to the current protocol", () => {
    expect(themeMessage(THEME)).toEqual({
      channel: EMBED_CHANNEL,
      protocol: EMBED_PROTOCOL_VERSION,
      type: HOST_THEME,
      theme: THEME,
    });
    expect(navigateMessage({ city: "hq" }).type).toBe(HOST_NAVIGATE);
    expect(apiMessage(API).type).toBe(HOST_API);
  });

  it("buildConfig fills protocol + capability defaults and carries optional city/route", () => {
    const minimal = buildConfig({ api: API, theme: THEME });
    expect(minimal.protocol).toBe(EMBED_PROTOCOL_VERSION);
    expect(minimal.capabilities).toEqual({ canOpenNative: true, canOpenExternal: true });
    expect(minimal.city).toBeUndefined();

    const full = buildConfig({ api: API, theme: THEME, city: "hq", route: { view: "agents" } });
    expect(full.city).toBe("hq");
    expect(full.route).toEqual({ view: "agents" });
  });
});

describe("DashboardBridge outbound", () => {
  it("posts the right message for each send method", () => {
    const posted: HostMessage[] = [];
    const bridge = new DashboardBridge({ post: (m) => posted.push(m) });

    bridge.sendConfig(buildConfig({ api: API, theme: THEME }));
    bridge.sendTheme(THEME);
    bridge.navigate({ city: "hq" });
    bridge.setApi({ baseUrl: "http://h:1", token: "t" });

    expect(posted.map((m) => m.type)).toEqual([HOST_CONFIG, HOST_THEME, HOST_NAVIGATE, HOST_API]);
  });
});

describe("DashboardBridge.receive", () => {
  function makeBridge() {
    const calls: Array<[string, unknown]> = [];
    const logs: Array<[BridgeLogLevel, string]> = [];
    const handlers: DashboardHandlers = {
      onReady: (p) => calls.push(["ready", p]),
      onNavigateNative: (t) => calls.push(["navigate-native", t]),
      onOpenExternal: (u) => calls.push(["open-external", u]),
      onRouteChanged: (r) => calls.push(["route-changed", r]),
      onError: (m, d) => calls.push(["error", { m, d }]),
    };
    const bridge = new DashboardBridge({
      post: () => {},
      handlers,
      log: (level, message) => logs.push([level, message]),
    });
    return { bridge, calls, logs };
  }

  it("dispatches each dashboard message to its handler", () => {
    const { bridge, calls } = makeBridge();
    bridge.receive(envelope(DASHBOARD_READY));
    bridge.receive(envelope(DASHBOARD_NAVIGATE_NATIVE, { target: { kind: "bead", id: "b1" } }));
    bridge.receive(envelope(DASHBOARD_OPEN_EXTERNAL, { url: "https://x.test" }));
    bridge.receive(envelope(DASHBOARD_ROUTE_CHANGED, { route: { view: "events" } }));
    bridge.receive(envelope(DASHBOARD_ERROR, { message: "boom", detail: "stack" }));

    expect(calls).toEqual([
      ["ready", EMBED_PROTOCOL_VERSION],
      ["navigate-native", { kind: "bead", id: "b1" }],
      ["open-external", "https://x.test"],
      ["route-changed", { view: "events" }],
      ["error", { m: "boom", d: "stack" }],
    ]);
  });

  it("drops unrecognised / malformed messages and logs at debug", () => {
    const { bridge, calls, logs } = makeBridge();
    expect(bridge.receive({ nope: true })).toBeNull();
    expect(bridge.receive(envelope("dashboard/unknown"))).toBeNull();
    expect(bridge.receive(envelope(DASHBOARD_OPEN_EXTERNAL, { url: "" }))).toBeNull();
    expect(calls).toEqual([]);
    expect(logs.every(([level]) => level === "debug")).toBe(true);
  });

  it("returns the parsed message for a recognised one", () => {
    const { bridge } = makeBridge();
    expect(bridge.receive(envelope(DASHBOARD_READY))?.type).toBe(DASHBOARD_READY);
  });

  it("warns on a protocol mismatch but still dispatches ready", () => {
    const { bridge, calls, logs } = makeBridge();
    bridge.receive({ channel: EMBED_CHANNEL, protocol: 99, type: DASHBOARD_READY });
    expect(calls).toEqual([["ready", 99]]);
    expect(logs.some(([level, msg]) => level === "warn" && msg.includes("protocol"))).toBe(true);
  });
});
