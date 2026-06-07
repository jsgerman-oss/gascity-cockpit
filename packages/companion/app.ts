// Orchestration for the web companion — the DOM-free core of the app.
//
// This is the first slice of the companion epic (cockpit-gj9): a standalone web
// companion that runs the SAME typed `/v0` client and the SAME live domain store
// the VS Code extension uses, imported — never forked (docs/companion-surfaces.md).
// The whole live surface (city health from snapshots, the event feed over the
// `/v0/events/stream` SSE feed, the durable reconnect/backoff) is the extension's
// own `core.status` layer: `FleetStatusStore` holds the state, `LiveStatus`
// orchestrates the typed client + `SupervisorEventStream` into it. We add only
// the browser shell around it.
//
// Deliberately DOM-free: it owns the data flow and renders by calling an injected
// `mount(pane, html)`, so it unit-tests in plain Node against a mock `/v0` with no
// browser and no real supervisor (app.test.ts). The thin DOM shell that wires
// `mount` to `innerHTML` lives in main.ts. Every collaborator is an injectable
// seam defaulting to the real `core`, mirroring how `LiveStatus` injects its own.
import * as core from "../../src/core/index.ts";
import {
  type PaneId,
  renderAgentsPane,
  renderEventsPane,
  renderHealthPane,
  renderSessionsPane,
} from "./render.ts";

export type { PaneId };

/** Where to reach a supervisor: base URL plus an optional bearer token. */
export type CompanionEndpoint = core.status.StatusEndpoint;

/** The localhost supervisor default, reused from the discovery contract. */
export const DEFAULT_ENDPOINT = core.discovery.DEFAULT_SUPERVISOR_BASE_URL;

/** Inject the mount + (for tests) the core seams; production uses the real `core`. */
export interface CompanionAppDeps {
  /** Supervisor endpoint the typed client and SSE stream talk to. */
  endpoint: CompanionEndpoint;
  /** Replace a pane's body with `html`. The DOM shell wires this to `innerHTML`. */
  mount: (pane: PaneId, html: string) => void;

  // --- seams, injectable for tests; production uses the real core ---
  /** Build the live status store (default a fresh {@link core.status.FleetStatusStore}). */
  createStore?: () => core.status.FleetStatusStore;
  /** Build the typed `/v0` client (default {@link core.api.createCockpitClient}). */
  createClient?: (endpoint: CompanionEndpoint) => core.api.CockpitClient;
  /** Build the durable SSE event stream (default {@link core.status.SupervisorEventStream}). */
  createStream?: (endpoint: CompanionEndpoint) => core.status.SupervisorEventStream;
}

/** A running companion: connect/live render, manual refresh, and teardown. */
export interface CompanionApp {
  /** Connect to the supervisor: snapshot city health and subscribe to the event feed. */
  start: () => void;
  /** Force an immediate city-health re-snapshot (the event feed stays live on its own). */
  refresh: () => void;
  /** Tear down the live connection and the store. */
  dispose: () => void;
}

/**
 * Resolve the supervisor endpoint from the page location — the companion's
 * "auto-discovery". Defaults to the page origin: the launch server (serve.mjs)
 * serves this bundle and reverse-proxies `/v0`, so a same-origin URL sidesteps
 * the CORS gap a direct cross-origin call hits (docs/companion-web.md). An
 * explicit `?endpoint=` overrides it for the day the supervisor speaks CORS; a
 * non-HTTP origin (opened as a `file://`) has no usable proxy, so it falls back
 * to the localhost supervisor default. An optional `?token=` threads a bearer
 * token onto every request and the stream, the seam a future auth model fills.
 */
export function resolveEndpoint(loc: { search: string; origin: string }): CompanionEndpoint {
  const params = new URLSearchParams(loc.search);
  const override = params.get("endpoint")?.trim();
  const token = params.get("token")?.trim();
  const baseUrl = override || (/^https?:\/\//.test(loc.origin) ? loc.origin : DEFAULT_ENDPOINT);
  return token ? { baseUrl, token } : { baseUrl };
}

export function createCompanionApp(deps: CompanionAppDeps): CompanionApp {
  const createStore = deps.createStore ?? (() => new core.status.FleetStatusStore());
  const createClient =
    deps.createClient ??
    ((endpoint) =>
      core.api.createCockpitClient({
        baseUrl: endpoint.baseUrl,
        headers: core.api.bearerAuthHeader(endpoint.token),
      }));
  const createStream =
    deps.createStream ??
    ((endpoint) =>
      new core.status.SupervisorEventStream(endpoint.baseUrl, {
        headers: core.api.bearerAuthHeader(endpoint.token),
      }));

  const store = createStore();
  const live = new core.status.LiveStatus({ store, createClient, createStream });
  const subscriptions: core.discovery.Disposable[] = [];

  function render(state: core.status.FleetStatusState): void {
    deps.mount("health", renderHealthPane(state));
    deps.mount("agents", renderAgentsPane(state));
    deps.mount("sessions", renderSessionsPane(state));
    deps.mount("events", renderEventsPane(state));
  }

  function start(): void {
    // Subscribe first, then connect: `connect` synchronously flips the store to
    // "loading", so the first render the operator sees is the shared connecting
    // row — never a premature "no cities" (cockpit-1ll.16).
    subscriptions.push(store.onDidChange((state) => render(state)));
    live.connect(deps.endpoint);
  }

  function refresh(): void {
    live.refreshNow();
  }

  function dispose(): void {
    live.dispose();
    for (const sub of subscriptions) sub.dispose();
    subscriptions.length = 0;
    store.dispose();
  }

  return { start, refresh, dispose };
}
