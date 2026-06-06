// DOM shell for the web companion — the browser analogue of the CLI's main.ts.
//
// Kept deliberately thin: it resolves the supervisor endpoint, wires `mount` to
// `innerHTML`, starts the app, and owns the one timer. All the data flow and
// rendering live in app.ts / render.ts (DOM-free, unit-tested); this file is the
// untested I/O edge, so esbuild bundles it to dist/web/app.js for the browser.
import { type PaneId, createWebApp } from "./app.ts";

/** How often (ms) to re-poll the Fleet and Beads snapshots. Telemetry is live over SSE. */
const REFRESH_INTERVAL_MS = 15_000;

/**
 * Resolve the `/v0` base URL. Defaults to the page origin — the launch server
 * (serve.mjs) serves this bundle and reverse-proxies `/v0` to the supervisor, so
 * a same-origin URL sidesteps the CORS gap that a direct cross-origin call hits
 * (docs/companion-web.md). An explicit `?endpoint=` overrides it for the day the
 * supervisor speaks CORS and the app can talk to it directly.
 */
function resolveEndpoint(): string {
  const override = new URLSearchParams(window.location.search).get("endpoint");
  return override && override.trim() ? override.trim() : window.location.origin;
}

function paneBody(pane: PaneId): HTMLElement {
  const el = document.getElementById(`${pane}-body`);
  if (!el) throw new Error(`missing pane container: ${pane}-body`);
  return el;
}

function main(): void {
  const endpoint = resolveEndpoint();

  const endpointEl = document.getElementById("endpoint");
  if (endpointEl) endpointEl.textContent = endpoint;

  const bodies: Record<PaneId, HTMLElement> = {
    fleet: paneBody("fleet"),
    beads: paneBody("beads"),
    telemetry: paneBody("telemetry"),
  };

  const app = createWebApp({
    baseUrl: endpoint,
    mount: (pane, html) => {
      bodies[pane].innerHTML = html;
    },
  });

  app.start();

  const refreshButton = document.getElementById("refresh");
  refreshButton?.addEventListener("click", () => void app.refresh());

  window.setInterval(() => void app.refresh(), REFRESH_INTERVAL_MS);
  window.addEventListener("beforeunload", () => app.dispose());
}

main();
