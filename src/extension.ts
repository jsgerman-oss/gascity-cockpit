/**
 * VS Code activation entry point for the GasCity Cockpit.
 *
 * Intentionally minimal (PRD: the editor-bound layer is kept small and excluded
 * from heavy unit testing). It builds the connection core — discovery,
 * reachability, the typed `/v0` client, the status indicator — as a
 * {@link FeatureHost}, then activates every registered feature against it. Each
 * feature lives in its own module under `./features` and wires itself onto the
 * host, so adding one never edits this file (cockpit-1ll.15). The logic worth
 * testing lives behind the `vscode`-free cores (`./discovery`, `./api`, …).
 */
import type * as vscode from 'vscode';
import { createCockpitHost } from './host/index.ts';
import { activateFeatures } from './features/index.ts';

export function activate(context: vscode.ExtensionContext): void {
  // Build the shared host (connection lifecycle, client, logger, repository),
  // wire every feature onto it, then start discovery — features subscribe to
  // status changes before the first connect fires.
  const { host, start } = createCockpitHost(context);
  activateFeatures(host);
  start();
}

export function deactivate(): void {
  // Disposables registered on context.subscriptions handle teardown.
}
