/**
 * The contract between the thin VS Code activation core and the cockpit
 * features.
 *
 * `extension.ts` builds a single {@link FeatureHost} — the connection lifecycle,
 * the typed client, the shared logger and beads repository — and hands it to
 * every {@link CockpitFeature}. Features wire themselves onto the host and push
 * their disposables onto `host.context.subscriptions`; they never edit
 * `extension.ts`. That is what lets features merge in parallel (cockpit-1ll.15):
 * adding one is a new module under `src/features/`, not an edit to shared glue.
 */
import type * as vscode from 'vscode';
import type { CockpitClient } from '../api/index.ts';
import type { BeadsRepository } from '../beads/index.ts';
import type { ApiEndpoint, ConnectionStatus, Logger } from '../discovery/index.ts';

/** The extension's configuration root (`gascityCockpit.*`). */
export const CONFIG_SECTION = 'gascityCockpit';

/** Minimal endpoint shape the shared client builder accepts. */
export interface ClientEndpoint {
  baseUrl: string;
  token?: string | null;
}

/**
 * A connection-status listener. Receives the new status and the previous state
 * (`null` on the first event after the host (re)builds its connection manager),
 * mirroring the transition bookkeeping the core used to own inline. Listeners
 * may declare only the params they use — a `(status) => void` is assignable.
 */
export type StatusListener = (
  status: ConnectionStatus,
  prevState: ConnectionStatus['state'] | null,
) => void;

/**
 * The shared services every feature is written against. Built once by the core
 * and passed to each feature's {@link CockpitFeature.activate}.
 */
export interface FeatureHost {
  /** The VS Code extension context — push feature disposables onto its subscriptions. */
  readonly context: vscode.ExtensionContext;
  /** Structured logger backed by the shared output channel. */
  readonly log: Logger;
  /** Shared beads repository, backed by the live client (kept in sync with the connection). */
  readonly repository: BeadsRepository;
  /** Typed client for the currently-connected supervisor, or `null` when unusable. */
  getClient(): CockpitClient | null;
  /** The currently-resolved API endpoint, or `null` when disconnected. */
  getEndpoint(): ApiEndpoint | null;
  /** The latest connection-status snapshot. */
  getStatus(): ConnectionStatus;
  /** Build a typed client for an arbitrary endpoint (shared construction + auth header). */
  createClient(endpoint: ClientEndpoint, timeoutMs?: number): CockpitClient;
  /**
   * Subscribe to connection-status changes. The host updates {@link getClient}
   * and {@link getEndpoint} before firing, so listeners always see fresh state.
   */
  onStatusChange(listener: StatusListener): vscode.Disposable;
  /** Request a manual reconnect of the supervisor connection. */
  reconnect(): void;
  /** Reveal the shared output channel. */
  showOutput(): void;
}

/**
 * A self-contained unit of cockpit functionality. Each feature is its own module
 * under `src/features/`; the generated registry collects them and the core
 * activates them in turn. The `id` is stable and unique (it scopes the feature's
 * `*.contributes.json` manifest and is asserted unique by the registry test).
 */
export interface CockpitFeature {
  /** Stable, unique feature id (matches its `<id>.contributes.json` manifest). */
  readonly id: string;
  /** Wire the feature onto the host. Push disposables to `host.context.subscriptions`. */
  activate(host: FeatureHost): void;
}
