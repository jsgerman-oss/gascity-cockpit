/**
 * Coverage for the event time-travel feature (cockpit-g5l.3, batch B).
 *
 * The feature runs its own durable event stream into a replayable timeline,
 * wired to the connection: it starts a stream on a fresh connect, dedupes
 * routine health polls, clears the recording and reconnects on a detected
 * restart, and tears the stream down when the API goes away. We spy the stream's
 * `start` (so no real SSE opens — it only counts) and the timeline's `clear`
 * to assert the feature drives each transition correctly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import timeTravelFeature from "./timeTravel.feature.ts";
import { SupervisorEventStream } from "../status/index.ts";
import { EventTimeline } from "../timetravel/index.ts";
import { createTestbed } from "../test/fake-host.ts";

const OPEN_COMMAND = "gascityCockpit.timeTravel.open";

/** Spy the stream's `start` so driving the feature never opens a socket. */
function spyStreamStart() {
  return vi.spyOn(SupervisorEventStream.prototype, "start").mockImplementation(() => {});
}

afterEach(() => vi.restoreAllMocks());

describe("timeTravel feature", () => {
  it("registers the open command", () => {
    spyStreamStart();
    const tb = createTestbed();
    tb.activate(timeTravelFeature);

    expect(tb.hasCommand(OPEN_COMMAND)).toBe(true);
    tb.disposeAll();
  });

  it("starts a recording stream on a fresh supervisor connection", () => {
    const start = spyStreamStart();
    const tb = createTestbed();
    tb.activate(timeTravelFeature);

    tb.emitStatus("connected");

    expect(start).toHaveBeenCalledTimes(1);
    tb.disposeAll();
  });

  it("does not restart the stream when an identical status repeats", () => {
    const start = spyStreamStart();
    const tb = createTestbed();
    tb.activate(timeTravelFeature);

    tb.emitStatus("connected");
    tb.emitStatus("connected"); // same endpoint, not restarted → deduped

    expect(start).toHaveBeenCalledTimes(1);
    tb.disposeAll();
  });

  it("clears the timeline and restarts the stream on a supervisor restart", () => {
    const start = spyStreamStart();
    const clear = vi.spyOn(EventTimeline.prototype, "clear");
    const tb = createTestbed();
    tb.activate(timeTravelFeature);

    tb.emitStatus("connected");
    tb.emitStatus("connected", { restarted: true });

    expect(clear).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    tb.disposeAll();
  });

  it("reconnects to a new endpoint without clearing the recording", () => {
    const start = spyStreamStart();
    const clear = vi.spyOn(EventTimeline.prototype, "clear");
    const tb = createTestbed();
    tb.activate(timeTravelFeature);

    tb.emitStatus("connected", {
      endpoint: { baseUrl: "http://a.test:1", token: null, mode: "supervisor", source: "default" },
    });
    tb.emitStatus("connected", {
      endpoint: { baseUrl: "http://b.test:2", token: null, mode: "supervisor", source: "default" },
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(clear).not.toHaveBeenCalled();
    tb.disposeAll();
  });

  it("tears the stream down when the supervisor becomes unavailable", () => {
    spyStreamStart();
    const streamDispose = vi.spyOn(SupervisorEventStream.prototype, "dispose");
    const tb = createTestbed();
    tb.activate(timeTravelFeature);

    tb.emitStatus("connected");
    tb.emitStatus("unavailable");

    expect(streamDispose).toHaveBeenCalled();
    tb.disposeAll();
  });

  it("ignores idle and endpointless statuses", () => {
    const start = spyStreamStart();
    const tb = createTestbed();
    tb.activate(timeTravelFeature);

    tb.emitStatus("idle"); // never connected → nothing to tear down
    tb.emitStatus("connected", { endpoint: null }); // connected but no endpoint → ignored

    expect(start).not.toHaveBeenCalled();
    tb.disposeAll();
  });

  it("opens a single reusable panel from the open command", async () => {
    spyStreamStart();
    const tb = createTestbed();
    tb.activate(timeTravelFeature);

    await tb.invokeCommand(OPEN_COMMAND);
    await tb.invokeCommand(OPEN_COMMAND); // re-open reveals the same panel

    expect(tb.state.webviewPanels).toHaveLength(1);
    tb.disposeAll();
  });

  it("disposes the timeline on teardown", () => {
    spyStreamStart();
    const timelineDispose = vi.spyOn(EventTimeline.prototype, "dispose");
    const tb = createTestbed();
    tb.activate(timeTravelFeature);
    tb.emitStatus("connected");

    tb.disposeAll();

    expect(timelineDispose).toHaveBeenCalled();
  });
});
