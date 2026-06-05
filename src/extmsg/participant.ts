// ExtMsgParticipant — makes the Cockpit a first-class, durable extmsg adapter.
//
// This is the seam the editor glue drives, mirroring `LiveStatus`:
// `connect(endpoint)` when the ConnectionManager reports a healthy supervisor,
// `disconnect()` when it goes away, and `connect()` again on a restart. On
// connect it starts the callback service, lists the supervisor's cities, and
// registers the Cockpit adapter (with the reachable callback URL) in each
// running city. The supervisor's adapter registry is in-memory and ephemeral
// (pack `docs/DESIGN.md` fork #2), so re-registering on every (re)connect is
// what makes the participant *durable* across controller restarts.
//
// Per fork #2 it refuses to register callback-less: if the callback service
// cannot start, no registration happens (a registration without a reachable
// callback is exactly the half-working state the pack avoids).
//
// All collaborators (client factory, callback server) are injected, keeping it
// `vscode`-free and unit-testable.
import type { CockpitClient } from "../api/index.ts";
import { listCities, registerAdapter, unregisterAdapter } from "../api/index.ts";
import type { Logger } from "../discovery/index.ts";
import type { CallbackDelivery, CallbackService } from "./callback-server.ts";
import { COCKPIT_ADAPTER_IDENTITY, cockpitAdapterSpec, type AdapterIdentity } from "./identity.ts";

/** Where to reach a supervisor: base URL plus an optional bearer token. */
export interface ParticipantEndpoint {
  baseUrl: string;
  token?: string;
}

/** Per-city outcome of the most recent registration attempt. */
export interface RegistrationState {
  city: string;
  status: "registered" | "error";
  /** Failure detail when `status === "error"`. */
  detail?: string;
}

/** A delivery received on the callback URL, stamped with arrival time. */
export interface RecordedDelivery extends CallbackDelivery {
  /** ISO-8601 arrival timestamp. */
  receivedAt: string;
}

export interface ExtMsgParticipantDeps {
  /** Build a typed client for an endpoint (injected so tests pass a mock). */
  createClient: (endpoint: ParticipantEndpoint) => CockpitClient;
  /** The callback service (its lifecycle is owned here). */
  callbackServer: CallbackService;
  /** Adapter identity overrides; defaults to {@link COCKPIT_ADAPTER_IDENTITY}. */
  identity?: Partial<AdapterIdentity>;
  /** Notified for each delivery received on the callback URL. */
  onDelivery?: (delivery: RecordedDelivery) => void;
  /** Recent deliveries retained for the status surface (default 20). */
  maxDeliveries?: number;
  /** Clock injection point for deterministic tests. */
  now?: () => string;
  log?: Logger;
}

export class ExtMsgParticipant {
  private readonly createClient: (endpoint: ParticipantEndpoint) => CockpitClient;
  private readonly callbackServer: CallbackService;
  private readonly identity: AdapterIdentity;
  private readonly onDeliveryCb: ((delivery: RecordedDelivery) => void) | undefined;
  private readonly maxDeliveries: number;
  private readonly now: () => string;
  private readonly log: Logger;

  private client: CockpitClient | null = null;
  private registrationsState: RegistrationState[] = [];
  private deliveries: RecordedDelivery[] = [];

  /** Bumped on connect/disconnect to invalidate in-flight registration work. */
  private generation = 0;

  constructor(deps: ExtMsgParticipantDeps) {
    this.createClient = deps.createClient;
    this.callbackServer = deps.callbackServer;
    this.identity = { ...COCKPIT_ADAPTER_IDENTITY, ...deps.identity };
    this.onDeliveryCb = deps.onDelivery;
    this.maxDeliveries = deps.maxDeliveries ?? 20;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.log = deps.log ?? (() => {});
    this.callbackServer.onDelivery = (d) => this.onCallbackDelivery(d);
  }

  /** The reachable callback URL once the service is up, else `null`. */
  get callbackUrl(): string | null {
    return this.callbackServer.url;
  }

  /** Per-city result of the most recent registration pass. */
  get registrations(): readonly RegistrationState[] {
    return this.registrationsState;
  }

  /** Most recent callback deliveries (newest last), capped at `maxDeliveries`. */
  get recentDeliveries(): readonly RecordedDelivery[] {
    return this.deliveries;
  }

  /** Whether the participant currently holds a connected client. */
  get connected(): boolean {
    return this.client !== null;
  }

  /**
   * Point the participant at a supervisor: start the callback service, enumerate
   * cities, and register the Cockpit adapter in each running city. Safe to call
   * again on reconnect or restart — it re-registers, which is the durability
   * mechanism since the server-side registry is ephemeral.
   */
  async connect(endpoint: ParticipantEndpoint): Promise<void> {
    this.generation += 1;
    const generation = this.generation;

    // 1. Ensure a reachable callback service. Refuse to register without one.
    let callbackUrl: string;
    try {
      callbackUrl = await this.callbackServer.start();
    } catch (err) {
      this.registrationsState = [];
      this.log("error", "extmsg: callback service failed to start; not registering", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (generation !== this.generation) return;

    // 2. Build a client and enumerate cities.
    const client = this.createClient(endpoint);
    this.client = client;

    const cities = await listCities(client);
    if (generation !== this.generation) return;
    if (!cities.ok) {
      this.registrationsState = [];
      this.log("warn", "extmsg: could not list cities for registration", {
        error: cities.error.detail ?? cities.error.title,
      });
      return;
    }

    const running = (cities.data.items ?? []).filter((c) => c.running);
    if (running.length === 0) {
      this.registrationsState = [];
      this.log("info", "extmsg: no running cities to register in");
      return;
    }

    // 3. Register per running city (in parallel; isolate per-city failures).
    const results = await Promise.all(
      running.map((c) => this.registerCity(client, c.name, callbackUrl)),
    );
    if (generation !== this.generation) return;
    this.registrationsState = results;

    const ok = results.filter((r) => r.status === "registered").length;
    this.log("info", "extmsg participant registered", {
      registered: ok,
      cities: results.length,
      callbackUrl,
    });
  }

  /**
   * Tear down: best-effort unregister from every city we registered in, then
   * drop the client. The callback service keeps running (kept alive until
   * {@link dispose}) so the URL stays stable across reconnects.
   */
  async disconnect(): Promise<void> {
    this.generation += 1;
    const client = this.client;
    const registered = this.registrationsState
      .filter((r) => r.status === "registered")
      .map((r) => r.city);
    this.client = null;
    this.registrationsState = [];
    if (client && registered.length > 0) {
      await Promise.all(registered.map((city) => this.unregisterCity(client, city)));
    }
  }

  /** Full teardown for extension deactivation: unregister and stop the service. */
  async dispose(): Promise<void> {
    await this.disconnect();
    this.callbackServer.onDelivery = undefined;
    await this.callbackServer.stop();
  }

  private async registerCity(
    client: CockpitClient,
    city: string,
    callbackUrl: string,
  ): Promise<RegistrationState> {
    const res = await registerAdapter(client, cockpitAdapterSpec(city, this.identity, callbackUrl));
    if (res.ok) {
      this.log("info", "extmsg adapter registered", { city, provider: this.identity.provider });
      return { city, status: "registered" };
    }
    const detail = res.error.detail ? `${res.error.title}: ${res.error.detail}` : res.error.title;
    this.log("warn", "extmsg adapter registration failed", { city, error: detail });
    return { city, status: "error", detail };
  }

  private async unregisterCity(client: CockpitClient, city: string): Promise<void> {
    const res = await unregisterAdapter(client, {
      cityName: city,
      provider: this.identity.provider,
      accountId: this.identity.accountId,
    });
    if (!res.ok) {
      // Best-effort: the registry is ephemeral, so a failed unregister (e.g. the
      // API already went away) is not actionable — note it and move on.
      this.log("debug", "extmsg adapter unregister failed (ignored)", {
        city,
        error: res.error.detail ?? res.error.title,
      });
    }
  }

  private onCallbackDelivery(delivery: CallbackDelivery): void {
    const recorded: RecordedDelivery = { ...delivery, receivedAt: this.now() };
    this.deliveries.push(recorded);
    if (this.deliveries.length > this.maxDeliveries) {
      this.deliveries.splice(0, this.deliveries.length - this.maxDeliveries);
    }
    this.log("info", "extmsg delivery received on callback");
    if (this.onDeliveryCb) {
      try {
        this.onDeliveryCb(recorded);
      } catch (err) {
        this.log("warn", "extmsg onDelivery callback threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
