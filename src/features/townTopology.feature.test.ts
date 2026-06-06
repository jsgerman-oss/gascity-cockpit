/**
 * Coverage for the live town-topology feature (cockpit-g5l.3, batch B).
 *
 * The graph streams only while its panel is open: opening connects to the
 * current supervisor, closing disconnects, and a restart/endpoint change while
 * open reconnects (routine health polls are deduped). When the API goes away it
 * disconnects and, on a hard `unavailable`, clears the stale snapshot. We spy the
 * `LiveStatus` seam (so no real client/stream is built — the feature's injected
 * `createClient` would otherwise need a live supervisor) and drive the panel
 * lifecycle through the contributed command and the panel's dispose.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import townTopologyFeature from "./townTopology.feature.ts";
import type { CockpitClient } from "../api/index.ts";
import { FleetStatusStore, LiveStatus, SupervisorEventStream } from "../status/index.ts";
import { createTestbed, type Testbed } from "../test/fake-host.ts";

const SHOW = "gascityCockpit.townTopology.show";

let active: Testbed | undefined;

function testbed(): Testbed {
  active = createTestbed();
  return active;
}

/** Invoke the show command and return the panel it created. */
async function openPanel(tb: Testbed) {
  await tb.invokeCommand(SHOW);
  return tb.state.webviewPanels.at(-1)!;
}

afterEach(() => {
  // The topology panel is a module-level singleton; closing any panel the test
  // opened resets it (idempotent) so the next test's open() runs onActivate.
  for (const panel of active?.state.webviewPanels ?? []) panel.dispose();
  active = undefined;
  vi.restoreAllMocks();
});

describe("townTopology feature", () => {
  it("registers the show command", () => {
    const tb = testbed();
    tb.activate(townTopologyFeature);

    expect(tb.hasCommand(SHOW)).toBe(true);
    tb.disposeAll();
  });

  it("does not stream while the panel is closed", () => {
    const connect = vi.spyOn(LiveStatus.prototype, "connect").mockImplementation(() => {});
    const tb = testbed();
    tb.activate(townTopologyFeature);

    tb.emitStatus("connected"); // no panel open → must not connect

    expect(connect).not.toHaveBeenCalled();
    tb.disposeAll();
  });

  it("connects to the current supervisor when the panel opens", async () => {
    const connect = vi.spyOn(LiveStatus.prototype, "connect").mockImplementation(() => {});
    const tb = testbed();
    tb.activate(townTopologyFeature);
    const status = tb.emitStatus("connected"); // settled before the panel opened

    await openPanel(tb); // onActivate seeds from the live connection

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({ baseUrl: status.endpoint!.baseUrl });
    tb.disposeAll();
  });

  it("connects when a supervisor arrives while the panel is already open", async () => {
    const connect = vi.spyOn(LiveStatus.prototype, "connect").mockImplementation(() => {});
    const tb = testbed();
    tb.activate(townTopologyFeature);

    await openPanel(tb); // opens against the idle default → nothing to connect yet
    expect(connect).not.toHaveBeenCalled();

    tb.emitStatus("connected");

    expect(connect).toHaveBeenCalledTimes(1);
    tb.disposeAll();
  });

  it("dedupes a routine health poll that does not change the endpoint", async () => {
    const connect = vi.spyOn(LiveStatus.prototype, "connect").mockImplementation(() => {});
    const tb = testbed();
    tb.activate(townTopologyFeature);
    await openPanel(tb);

    tb.emitStatus("connected");
    tb.emitStatus("connected"); // identical endpoint, not restarted → deduped

    expect(connect).toHaveBeenCalledTimes(1);
    tb.disposeAll();
  });

  it("carries the bearer token into the endpoint when present", async () => {
    const connect = vi.spyOn(LiveStatus.prototype, "connect").mockImplementation(() => {});
    const tb = testbed();
    tb.activate(townTopologyFeature);
    await openPanel(tb);

    tb.emitStatus("connected", {
      endpoint: { baseUrl: "http://tok.test:7", token: "secret", mode: "supervisor", source: "default" },
    });

    expect(connect).toHaveBeenCalledWith({ baseUrl: "http://tok.test:7", token: "secret" });
    tb.disposeAll();
  });

  it("disconnects and clears the snapshot when the supervisor is unavailable", () => {
    const disconnect = vi.spyOn(LiveStatus.prototype, "disconnect");
    const clearSnapshot = vi.spyOn(FleetStatusStore.prototype, "clearSnapshot");
    const tb = testbed();
    tb.activate(townTopologyFeature);

    tb.emitStatus("unavailable");

    expect(disconnect).toHaveBeenCalled();
    expect(clearSnapshot).toHaveBeenCalled();
    tb.disposeAll();
  });

  it("disconnects without clearing the snapshot when the connection goes idle", () => {
    const disconnect = vi.spyOn(LiveStatus.prototype, "disconnect");
    const clearSnapshot = vi.spyOn(FleetStatusStore.prototype, "clearSnapshot");
    const tb = testbed();
    tb.activate(townTopologyFeature);

    tb.emitStatus("idle");

    expect(disconnect).toHaveBeenCalled();
    expect(clearSnapshot).not.toHaveBeenCalled();
    tb.disposeAll();
  });

  it("ignores a connected status that carries no endpoint", () => {
    const connect = vi.spyOn(LiveStatus.prototype, "connect").mockImplementation(() => {});
    const disconnect = vi.spyOn(LiveStatus.prototype, "disconnect").mockImplementation(() => {});
    const tb = testbed();
    tb.activate(townTopologyFeature);

    tb.emitStatus("connected", { endpoint: null });

    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    tb.disposeAll();
  });

  it("stops streaming when the panel closes", async () => {
    const connect = vi.spyOn(LiveStatus.prototype, "connect").mockImplementation(() => {});
    const disconnect = vi.spyOn(LiveStatus.prototype, "disconnect").mockImplementation(() => {});
    const tb = testbed();
    tb.activate(townTopologyFeature);
    const panel = await openPanel(tb);
    tb.emitStatus("connected");
    expect(connect).toHaveBeenCalledTimes(1);

    panel.dispose(); // user closes the panel → onDeactivate

    expect(disconnect).toHaveBeenCalled();
    tb.disposeAll();
  });

  it("builds a real client and stream through the injected factories", async () => {
    // Don't mock connect here — let it run so the feature's `createClient` and
    // `createStream` factories execute. The stream's `start` is stubbed (no SSE),
    // and the snapshot refresh runs against a fake client that answers offline,
    // so the factories are exercised without any real socket.
    const start = vi.spyOn(SupervisorEventStream.prototype, "start").mockImplementation(() => {});
    const fakeClient = {
      GET: async () => ({ data: undefined, error: { title: "offline" } }),
    } as unknown as CockpitClient;
    active = createTestbed({ createClient: () => fakeClient });
    const tb = active;
    tb.activate(townTopologyFeature);
    await openPanel(tb);

    tb.emitStatus("connected");
    await tb.flush();

    expect(start).toHaveBeenCalledTimes(1);
    tb.disposeAll();
  });

  it("tears down the live status and store on dispose", () => {
    const liveDispose = vi.spyOn(LiveStatus.prototype, "dispose");
    const storeDispose = vi.spyOn(FleetStatusStore.prototype, "dispose");
    const tb = testbed();
    tb.activate(townTopologyFeature);

    tb.disposeAll();

    expect(liveDispose).toHaveBeenCalled();
    expect(storeDispose).toHaveBeenCalled();
  });
});
