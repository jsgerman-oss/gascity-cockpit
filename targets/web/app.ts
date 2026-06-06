// Orchestration for the web companion — the `fleet-status.ts` of this target.
//
// Deliberately DOM-free: it owns the data flow (create the typed client, fetch
// the Fleet and Beads snapshots over `/v0`, drive the live Telemetry SSE stream)
// and renders by calling an injected `mount(pane, html)`. Keeping `document` out
// of here means the orchestration unit-tests in plain Node with a fake mount and
// fake `core` seams (app.test.ts), while the thin DOM shell that actually wires
// `mount` to `innerHTML` lives in main.ts. Every `core` seam is injectable and
// defaults to the real one, mirroring how the domain stores inject their streams.
import * as core from "../../src/core/index.ts";
import {
  type PaneView,
  renderBeadsPane,
  renderFleetPane,
  renderTelemetryPane,
} from "./render.ts";

/** The three read-only panes the companion surfaces. */
export type PaneId = "fleet" | "beads" | "telemetry";

/** Inject the page-origin renderer; everything else defaults to the real `core`. */
export interface WebAppDeps {
  /** Supervisor base URL the typed client and SSE stream talk to. */
  baseUrl: string;
  /** Replace a pane's body with `html`. The DOM shell wires this to `innerHTML`. */
  mount: (pane: PaneId, html: string) => void;

  // --- seams, injectable for tests; production uses the real core ---
  /** Build the typed `/v0` client (default {@link core.api.createCockpitClient}). */
  createClient?: (baseUrl: string) => core.api.CockpitClient;
  /** Read a fleet snapshot (default {@link core.status.fetchFleetSnapshot}). */
  fetchFleet?: (client: core.api.CockpitClient) => Promise<core.status.FleetSnapshot>;
  /** Load the multi-city beads dataset (default a {@link core.beads.BeadsRepository}). */
  loadBeads?: (client: core.api.CockpitClient) => Promise<core.beads.ExplorerData>;
  /** Build the telemetry store (default a fresh {@link core.telemetry.TelemetryStore}). */
  createTelemetryStore?: () => core.telemetry.TelemetryStore;
  /** Build the telemetry SSE stream (default {@link core.telemetry.TelemetryStream}). */
  createTelemetryStream?: (endpoint: core.telemetry.TelemetryEndpoint) => core.telemetry.TelemetryStream;
}

/** Normalise any thrown value into a one-line, display-ready cause. */
function causeOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A running companion: initial render, manual refresh, and teardown. */
export interface WebApp {
  /** Mount loading rows, fetch Fleet + Beads, and connect the live Telemetry feed. */
  start: () => void;
  /** Re-fetch the Fleet and Beads snapshots (Telemetry stays live on its own). */
  refresh: () => Promise<void>;
  /** Tear down the Telemetry stream. */
  dispose: () => void;
}

export function createWebApp(deps: WebAppDeps): WebApp {
  const createClient = deps.createClient ?? ((baseUrl) => core.api.createCockpitClient({ baseUrl }));
  const fetchFleet = deps.fetchFleet ?? ((client) => core.status.fetchFleetSnapshot(client));
  const loadBeads =
    deps.loadBeads ??
    ((client) => new core.beads.BeadsRepository({ getClient: () => client }).loadExplorer());
  const createTelemetryStore = deps.createTelemetryStore ?? (() => new core.telemetry.TelemetryStore());
  const createTelemetryStream =
    deps.createTelemetryStream ?? ((endpoint) => new core.telemetry.TelemetryStream(endpoint.baseUrl));

  const client = createClient(deps.baseUrl);
  const store = createTelemetryStore();
  const live = new core.telemetry.LiveTelemetry({ store, createStream: createTelemetryStream });

  function mountFleet(view: PaneView<core.status.FleetSnapshot>): void {
    deps.mount("fleet", renderFleetPane(view));
  }
  function mountBeads(view: PaneView<core.beads.ExplorerData>): void {
    deps.mount("beads", renderBeadsPane(view));
  }
  function mountTelemetry(view: PaneView<core.telemetry.TelemetryState>): void {
    deps.mount("telemetry", renderTelemetryPane(view));
  }

  async function refreshFleet(): Promise<void> {
    mountFleet({ status: "loading" });
    try {
      mountFleet({ status: "ready", data: await fetchFleet(client) });
    } catch (err) {
      mountFleet({ status: "error", detail: causeOf(err) });
    }
  }

  async function refreshBeads(): Promise<void> {
    mountBeads({ status: "loading" });
    try {
      mountBeads({ status: "ready", data: await loadBeads(client) });
    } catch (err) {
      mountBeads({ status: "error", detail: causeOf(err) });
    }
  }

  async function refresh(): Promise<void> {
    await Promise.all([refreshFleet(), refreshBeads()]);
  }

  const disposables: Array<{ dispose: () => void }> = [];

  function start(): void {
    // Telemetry is event-sourced: show the shared loading row, then let the store
    // push every rollup as `worker.operation` events arrive over SSE.
    mountTelemetry({ status: "loading" });
    disposables.push(store.onDidChange((state) => mountTelemetry({ status: "ready", data: state })));
    live.connect({ baseUrl: deps.baseUrl });
    void refresh();
  }

  function dispose(): void {
    live.dispose();
    for (const d of disposables) d.dispose();
    disposables.length = 0;
    store.dispose();
  }

  return { start, refresh, dispose };
}
