// DOM shell for the web companion — the one browser/I-O edge.
//
// Kept deliberately thin: it resolves the supervisor endpoint, wires `mount` to
// `innerHTML`, starts the app, and owns the one backup timer. All the data flow,
// the live store wiring, and the rendering live in app.ts / render.ts (DOM-free,
// unit-tested against a mock /v0); this file is the untested edge, so esbuild
// bundles it to dist/companion/app.js for the browser and coverage excludes it
// (vitest.config.ts), exactly like every other `targets/<t>/main.ts` shell.
import { type PaneId, createCompanionApp, resolveEndpoint } from "./app.ts";

/**
 * Backup re-snapshot cadence (ms). City health is already kept live by the event
 * feed (LiveStatus re-snapshots on every status-affecting event), so this is only
 * a safety net for a quiet or disconnected stream — long, not chatty.
 */
const BACKUP_REFRESH_MS = 30_000;

function paneBody(pane: PaneId): HTMLElement {
  const el = document.getElementById(`${pane}-body`);
  if (!el) throw new Error(`missing pane container: ${pane}-body`);
  return el;
}

function main(): void {
  const endpoint = resolveEndpoint(window.location);

  const endpointEl = document.getElementById("endpoint");
  if (endpointEl) endpointEl.textContent = endpoint.baseUrl;

  const bodies: Record<PaneId, HTMLElement> = {
    health: paneBody("health"),
    events: paneBody("events"),
  };

  const app = createCompanionApp({
    endpoint,
    mount: (pane, html) => {
      bodies[pane].innerHTML = html;
    },
  });

  app.start();

  const refreshButton = document.getElementById("refresh");
  refreshButton?.addEventListener("click", () => app.refresh());

  window.setInterval(() => app.refresh(), BACKUP_REFRESH_MS);
  window.addEventListener("beforeunload", () => app.dispose());
}

main();
