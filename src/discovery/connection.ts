/**
 * ConnectionManager — the resilience half of the contract.
 *
 * Treats API availability as transient. It discovers an endpoint, confirms it
 * with `/health`, then polls to notice the API going away (`gc stop`, supervisor
 * restart). On loss it backs off, **re-discovers** (the port/descriptor may have
 * changed across a restart), and reconnects. It detects restarts via `build_id`
 * so downstream consumers can resubscribe streams and invalidate caches.
 *
 * All side effects (discovery, probing, time, timers, randomness) are injected,
 * so the whole state machine is unit-testable with a fake clock and no sockets.
 */

import { Emitter } from './emitter.ts';
import type { DiscoveryResult } from './discovery.ts';
import type {
  ApiEndpoint,
  ConnectionState,
  ConnectionStatus,
  HealthResponse,
  Logger,
} from './types.ts';
import { isHealthy } from './health.ts';

export interface ConnectionOptions {
  /** Poll interval (ms) while connected. */
  pollIntervalMs: number;
  /** Faster poll (ms) while degraded (server still starting up). */
  degradedPollMs: number;
  /** Base delay (ms) for exponential reconnect backoff. */
  baseDelayMs: number;
  /** Ceiling (ms) for exponential reconnect backoff. */
  maxDelayMs: number;
  /** ±fraction of jitter applied to each backoff delay. */
  jitterFactor: number;
  /** Consecutive failures before surfacing the explicit `unavailable` state. */
  unavailableAfterAttempts: number;
}

export const DEFAULT_CONNECTION_OPTIONS: ConnectionOptions = {
  pollIntervalMs: 10_000,
  degradedPollMs: 1_000,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitterFactor: 0.2,
  unavailableAfterAttempts: 4,
};

export interface ConnectionDeps {
  /** Resolve an endpoint via the discovery precedence chain. */
  discover: () => Promise<DiscoveryResult>;
  /** Probe `/health` for a resolved endpoint. Rejects when unreachable. */
  probe: (endpoint: ApiEndpoint) => Promise<HealthResponse>;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  log?: Logger;
  options?: Partial<ConnectionOptions>;
}

/**
 * Pure backoff function (exported for direct testing): exponential by attempt,
 * capped at `maxDelayMs`, then ±`jitterFactor` jitter. `attempt` is 1-based.
 */
export function backoffDelay(
  attempt: number,
  opts: Pick<ConnectionOptions, 'baseDelayMs' | 'maxDelayMs' | 'jitterFactor'>,
  random: () => number,
): number {
  const exp = opts.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(opts.maxDelayMs, exp);
  const jitter = (random() * 2 - 1) * opts.jitterFactor; // [-jitterFactor, +jitterFactor)
  return Math.max(0, Math.round(capped * (1 + jitter)));
}

export class ConnectionManager {
  private readonly deps: Required<Omit<ConnectionDeps, 'options'>>;
  private readonly options: ConnectionOptions;
  private readonly emitter = new Emitter<ConnectionStatus>();

  private state: ConnectionState = 'idle';
  private endpoint: ApiEndpoint | null = null;
  private health: HealthResponse | null = null;
  private failedAttempts = 0;
  private detail = 'not started';

  private running = false;
  /** Bumped on start/stop/reconnect to invalidate in-flight async callbacks. */
  private generation = 0;
  private timer: unknown = null;
  /** build_id of the last successful probe, for restart detection. */
  private lastBuildId: string | null = null;
  /** Set when a restart is detected; flushed onto the next connected status. */
  private pendingRestart = false;

  constructor(deps: ConnectionDeps) {
    this.deps = {
      discover: deps.discover,
      probe: deps.probe,
      now: deps.now ?? (() => Date.now()),
      setTimer: deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms)),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      random: deps.random ?? Math.random,
      log: deps.log ?? (() => {}),
    };
    this.options = { ...DEFAULT_CONNECTION_OPTIONS, ...deps.options };
  }

  /** Subscribe to status changes. Fires on every transition. */
  readonly onDidChangeStatus = this.emitter.event;

  /** Current status snapshot. */
  get status(): ConnectionStatus {
    return {
      state: this.state,
      endpoint: this.endpoint,
      health: this.health,
      failedAttempts: this.failedAttempts,
      detail: this.detail,
      restarted: false,
    };
  }

  /** Begin discovery + connection. Idempotent while already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.failedAttempts = 0;
    this.endpoint = null;
    this.scheduleNow();
  }

  /** Force an immediate re-discovery + reconnect (e.g. user command). */
  reconnect(): void {
    if (!this.running) {
      this.start();
      return;
    }
    this.generation += 1;
    this.clearTimer();
    this.failedAttempts = 0;
    this.endpoint = null;
    this.detail = 'manual reconnect';
    this.scheduleNow();
  }

  /** Stop the manager. Transitions to `idle` and cancels pending work. */
  stop(): void {
    if (!this.running && this.state === 'idle') return;
    this.running = false;
    this.generation += 1;
    this.clearTimer();
    this.endpoint = null;
    this.health = null;
    this.transition('idle', 'stopped');
  }

  dispose(): void {
    this.stop();
    this.emitter.dispose();
  }

  // ---- internal machinery -------------------------------------------------

  private scheduleNow(): void {
    this.schedule(() => void this.tick(this.generation), 0);
  }

  private schedule(cb: () => void, ms: number): void {
    this.clearTimer();
    this.timer = this.deps.setTimer(cb, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** One discover-(if needed)-then-probe cycle. */
  private async tick(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;

    // Discover an endpoint if we don't currently hold one.
    if (!this.endpoint) {
      this.transition('discovering', 'resolving API endpoint');
      let result: DiscoveryResult;
      try {
        result = await this.deps.discover();
      } catch (err) {
        if (!this.alive(generation)) return;
        this.onFailure(`discovery error: ${message(err)}`);
        return;
      }
      if (!this.alive(generation)) return;
      if (!result.ok || !result.endpoint) {
        this.onFailure(this.summarizeDiscovery(result));
        return;
      }
      this.endpoint = result.endpoint;
    }

    // Confirm liveness. Stay silent (no 'connecting' flicker) on routine polls.
    if (this.state !== 'connected' && this.state !== 'degraded') {
      this.transition('connecting', `probing ${this.endpoint.baseUrl}`);
    }

    let health: HealthResponse;
    try {
      health = await this.deps.probe(this.endpoint);
    } catch (err) {
      if (!this.alive(generation)) return;
      // The endpoint may be gone (gc stop / restart on a new port). Drop it so
      // the next tick re-runs full discovery.
      const lost = this.endpoint?.baseUrl ?? '(unknown)';
      this.endpoint = null;
      this.onFailure(`health probe failed (${lost}): ${message(err)}`);
      return;
    }
    if (!this.alive(generation)) return;
    this.onProbeSuccess(health);
  }

  private onProbeSuccess(health: HealthResponse): void {
    // Restart detection: a changed build_id across successful probes means the
    // server was rebuilt/restarted. Empty build_id => can't tell, skip.
    if (this.lastBuildId !== null && health.build_id !== '' && health.build_id !== this.lastBuildId) {
      this.pendingRestart = true;
      this.deps.log('info', 'connection: server restart detected', {
        from: this.lastBuildId,
        to: health.build_id,
      });
    }
    if (health.build_id !== '') this.lastBuildId = health.build_id;

    this.health = health;
    this.failedAttempts = 0;

    if (isHealthy(health)) {
      this.transition('connected', `connected (${health.version})`, this.takeRestart());
      this.schedule(() => void this.tick(this.generation), this.options.pollIntervalMs);
    } else {
      this.transition('degraded', `starting: ${health.startup.phase}`);
      this.schedule(() => void this.tick(this.generation), this.options.degradedPollMs);
    }
  }

  private onFailure(detail: string): void {
    this.failedAttempts += 1;
    this.health = null;
    const next: ConnectionState =
      this.failedAttempts >= this.options.unavailableAfterAttempts ? 'unavailable' : 'reconnecting';
    const delay = backoffDelay(this.failedAttempts, this.options, this.deps.random);
    this.deps.log('warn', 'connection: attempt failed', {
      attempt: this.failedAttempts,
      state: next,
      retryInMs: delay,
      detail,
    });
    this.transition(next, `${detail} — retrying in ${Math.round(delay)}ms (attempt ${this.failedAttempts})`);
    this.schedule(() => void this.tick(this.generation), delay);
  }

  private summarizeDiscovery(result: DiscoveryResult): string {
    const tried = result.attempts.map((a) => `${a.source}:${a.ok ? 'ok' : a.reason ?? 'fail'}`).join('; ');
    return `no reachable API endpoint (${tried || 'no candidates'})`;
  }

  private alive(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private takeRestart(): boolean {
    const r = this.pendingRestart;
    this.pendingRestart = false;
    return r;
  }

  private transition(state: ConnectionState, detail: string, restarted = false): void {
    this.state = state;
    this.detail = detail;
    this.emitter.fire({
      state,
      endpoint: this.endpoint,
      health: this.health,
      failedAttempts: this.failedAttempts,
      detail,
      restarted,
    });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
