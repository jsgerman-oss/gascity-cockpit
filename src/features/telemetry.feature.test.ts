/**
 * Coverage for the cost & tier telemetry feature (cockpit-g5l.3, batch B).
 *
 * The feature owns a telemetry store/live pair and binds the live stream to a
 * fully-connected supervisor — connecting on a fresh endpoint or a detected
 * restart, deduping routine health polls, and disconnecting when the API goes
 * away. We spy the `LiveTelemetry` seam (so no real SSE opens) and assert the
 * feature drives it on exactly the right transitions, with the right endpoint.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import telemetryFeature from "./telemetry.feature.ts";
import { LiveTelemetry, TelemetryStore, TelemetryStream } from "../telemetry/index.ts";
import { createTestbed } from "../test/fake-host.ts";

const TELEMETRY_VIEW = "gascityCockpit.telemetry";
const CLEAR_COMMAND = "gascityCockpit.clearTelemetry";

afterEach(() => vi.restoreAllMocks());

describe("telemetry feature", () => {
  it("registers the telemetry view and its clear command", () => {
    vi.spyOn(LiveTelemetry.prototype, "connect").mockImplementation(() => {});
    const tb = createTestbed();
    tb.activate(telemetryFeature);

    expect(tb.getView(TELEMETRY_VIEW)).toBeDefined();
    expect(tb.hasCommand(CLEAR_COMMAND)).toBe(true);
    tb.disposeAll();
  });

  it("connects the stream on a fresh supervisor connection (no token)", () => {
    const connect = vi.spyOn(LiveTelemetry.prototype, "connect").mockImplementation(() => {});
    const tb = createTestbed();
    tb.activate(telemetryFeature);

    const status = tb.emitStatus("connected");

    expect(connect).toHaveBeenCalledTimes(1);
    // A tokenless endpoint carries only the base URL (no `token` key).
    expect(connect).toHaveBeenCalledWith({ baseUrl: status.endpoint!.baseUrl });
    tb.disposeAll();
  });

  it("carries the bearer token into the endpoint when present", () => {
    const connect = vi.spyOn(LiveTelemetry.prototype, "connect").mockImplementation(() => {});
    const tb = createTestbed();
    tb.activate(telemetryFeature);

    tb.emitStatus("connected", {
      endpoint: { baseUrl: "http://tok.test:9999", token: "secret", mode: "supervisor", source: "default" },
    });

    expect(connect).toHaveBeenCalledWith({ baseUrl: "http://tok.test:9999", token: "secret" });
    tb.disposeAll();
  });

  it("does not reconnect when an identical connected status repeats", () => {
    const connect = vi.spyOn(LiveTelemetry.prototype, "connect").mockImplementation(() => {});
    const tb = createTestbed();
    tb.activate(telemetryFeature);

    tb.emitStatus("connected");
    tb.emitStatus("connected"); // same endpoint, not restarted → deduped

    expect(connect).toHaveBeenCalledTimes(1);
    tb.disposeAll();
  });

  it("reconnects when the supervisor reports a restart", () => {
    const connect = vi.spyOn(LiveTelemetry.prototype, "connect").mockImplementation(() => {});
    const tb = createTestbed();
    tb.activate(telemetryFeature);

    tb.emitStatus("connected");
    tb.emitStatus("connected", { restarted: true }); // same endpoint, but restarted

    expect(connect).toHaveBeenCalledTimes(2);
    tb.disposeAll();
  });

  it("disconnects when the supervisor becomes unavailable", () => {
    const connect = vi.spyOn(LiveTelemetry.prototype, "connect").mockImplementation(() => {});
    const disconnect = vi.spyOn(LiveTelemetry.prototype, "disconnect").mockImplementation(() => {});
    const tb = createTestbed();
    tb.activate(telemetryFeature);

    tb.emitStatus("connected");
    tb.emitStatus("unavailable");

    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    tb.disposeAll();
  });

  it("does not disconnect an idle feed that never connected", () => {
    const disconnect = vi.spyOn(LiveTelemetry.prototype, "disconnect").mockImplementation(() => {});
    const tb = createTestbed();
    tb.activate(telemetryFeature);

    tb.emitStatus("idle"); // liveKey was never set → nothing to tear down

    expect(disconnect).not.toHaveBeenCalled();
    tb.disposeAll();
  });

  it("ignores a connected status with no endpoint", () => {
    const connect = vi.spyOn(LiveTelemetry.prototype, "connect").mockImplementation(() => {});
    const disconnect = vi.spyOn(LiveTelemetry.prototype, "disconnect").mockImplementation(() => {});
    const tb = createTestbed();
    tb.activate(telemetryFeature);

    tb.emitStatus("connected", { endpoint: null });

    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    tb.disposeAll();
  });

  it("builds and starts a real telemetry stream through the injected factory", () => {
    // Don't mock connect here — let it run so the feature's `createStream`
    // factory builds a real TelemetryStream. Only its `start` is stubbed, so the
    // stream is constructed and wired but no SSE socket opens.
    const start = vi.spyOn(TelemetryStream.prototype, "start").mockImplementation(() => {});
    const tb = createTestbed();
    tb.activate(telemetryFeature);

    tb.emitStatus("connected");

    expect(start).toHaveBeenCalledTimes(1);
    tb.disposeAll();
  });

  it("tears down the live stream and store on dispose", () => {
    vi.spyOn(LiveTelemetry.prototype, "connect").mockImplementation(() => {});
    const liveDispose = vi.spyOn(LiveTelemetry.prototype, "dispose");
    const storeDispose = vi.spyOn(TelemetryStore.prototype, "dispose");
    const tb = createTestbed();
    tb.activate(telemetryFeature);

    tb.disposeAll();

    expect(liveDispose).toHaveBeenCalled();
    expect(storeDispose).toHaveBeenCalled();
  });
});
