// Orchestration tests for the web companion. The app is DOM-free by design, so
// these drive it in plain Node with a fake `mount` and fake `core` seams,
// asserting the loading → ready / error transitions and the live-telemetry
// wiring without a browser, a network, or a real supervisor.
import { describe, expect, it } from "vitest";
import * as core from "../../src/core/index.ts";
import { type PaneId, createWebApp } from "./app.ts";

/** Records the latest HTML mounted per pane. */
function recorder() {
  const last: Partial<Record<PaneId, string>> = {};
  const calls: Array<[PaneId, string]> = [];
  return {
    mount: (pane: PaneId, html: string) => {
      last[pane] = html;
      calls.push([pane, html]);
    },
    last,
    calls,
  };
}

/** A controllable stand-in for the telemetry SSE stream (structurally cast). */
function fakeStream() {
  let eventCb: ((op: core.telemetry.WorkerOperation) => void) | undefined;
  const state = { started: false, disposed: false };
  const stream = {
    onEvent: (cb: (op: core.telemetry.WorkerOperation) => void) => {
      eventCb = cb;
      return { dispose() {} };
    },
    onStatus: () => ({ dispose() {} }),
    start: () => {
      state.started = true;
    },
    dispose: () => {
      state.disposed = true;
    },
  };
  return {
    stream: stream as unknown as core.telemetry.TelemetryStream,
    emit: (op: core.telemetry.WorkerOperation) => eventCb?.(op),
    state,
  };
}

const client = {} as core.api.CockpitClient;
const emptyFleet: core.status.FleetSnapshot = {
  health: null,
  cities: [{ name: "alpha", running: true } as core.status.CityInfo],
  agentsByCity: {},
  sessionsByCity: {},
  partialErrors: [],
};
const emptyBeads: core.beads.ExplorerData = { cities: [{ city: "alpha", running: true, partial: false, records: [] }] };

function op(seq: number): core.telemetry.WorkerOperation {
  return {
    seq,
    ts: "",
    city: "alpha",
    agent: "furiosa",
    bead: "b-1",
    model: "opus",
    provider: "claude",
    operation: "session.submit",
    result: "ok",
    ok: true,
    durationMs: 1000,
    opId: `o${seq}`,
  };
}

describe("createWebApp", () => {
  it("returns a runnable app with default core seams", () => {
    const app = createWebApp({ baseUrl: "http://127.0.0.1:8372", mount: () => {} });
    expect(typeof app.start).toBe("function");
    expect(typeof app.refresh).toBe("function");
    expect(typeof app.dispose).toBe("function");
  });

  it("mounts loading immediately, then the ready snapshots", async () => {
    const rec = recorder();
    const fake = fakeStream();
    const app = createWebApp({
      baseUrl: "http://x",
      mount: rec.mount,
      createClient: () => client,
      fetchFleet: () => Promise.resolve(emptyFleet),
      loadBeads: () => Promise.resolve(emptyBeads),
      createTelemetryStore: () => new core.telemetry.TelemetryStore(),
      createTelemetryStream: () => fake.stream,
    });

    app.start();
    // Loading is mounted synchronously for all three panes.
    expect(rec.last.fleet).toContain("notice--loading");
    expect(rec.last.beads).toContain("notice--loading");
    expect(rec.last.telemetry).toContain("notice--loading");
    expect(fake.state.started).toBe(true);

    await app.refresh();
    expect(rec.last.fleet).toContain("alpha");
    expect(rec.last.beads).toContain("No open beads");
  });

  it("renders live telemetry as operations arrive over the (fake) stream", async () => {
    const rec = recorder();
    const fake = fakeStream();
    const app = createWebApp({
      baseUrl: "http://x",
      mount: rec.mount,
      createClient: () => client,
      fetchFleet: () => Promise.resolve(emptyFleet),
      loadBeads: () => Promise.resolve(emptyBeads),
      createTelemetryStore: () => new core.telemetry.TelemetryStore(),
      createTelemetryStream: () => fake.stream,
    });

    app.start();
    // Event-sourced: the store is empty and silent until an op lands, so the
    // pane sits on the shared loading row.
    expect(rec.last.telemetry).toContain("notice--loading");

    fake.emit(op(1));
    expect(rec.last.telemetry).toContain("furiosa");
    expect(rec.last.telemetry).toContain("By agent");
  });

  it("mounts the shared error notice when a fetch rejects", async () => {
    const rec = recorder();
    const app = createWebApp({
      baseUrl: "http://x",
      mount: rec.mount,
      createClient: () => client,
      fetchFleet: () => Promise.reject(new Error("fleet boom")),
      loadBeads: () => Promise.reject(new Error("beads boom")),
      createTelemetryStream: () => fakeStream().stream,
    });

    await app.refresh();
    expect(rec.last.fleet).toContain("Couldn&#39;t load the fleet.");
    expect(rec.last.fleet).toContain("fleet boom");
    expect(rec.last.beads).toContain("Couldn&#39;t load beads.");
    expect(rec.last.beads).toContain("beads boom");
  });

  it("tears down the telemetry stream on dispose", () => {
    const fake = fakeStream();
    const app = createWebApp({
      baseUrl: "http://x",
      mount: () => {},
      createClient: () => client,
      fetchFleet: () => Promise.resolve(emptyFleet),
      loadBeads: () => Promise.resolve(emptyBeads),
      createTelemetryStream: () => fake.stream,
    });
    app.start();
    app.dispose();
    expect(fake.state.disposed).toBe(true);
  });
});
