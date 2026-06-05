// LiveTelemetry — wires a durable telemetry stream into the store.
//
// The seam the editor glue drives: `connect(endpoint)` when the connection
// manager reports a healthy supervisor, `disconnect()` when it goes away. Unlike
// LiveStatus there is no snapshot to poll — the rollups are built purely from the
// `worker.operation` event feed — so this is a thin lifecycle owner. The stream
// factory is injected, keeping it `vscode`-free and unit-testable.
import type { Disposable } from '../discovery/index.ts';
import type { TelemetryStream } from './events.ts';
import type { TelemetryStore } from './store.ts';

/** Where to reach a supervisor: base URL plus an optional bearer token. */
export interface TelemetryEndpoint {
  baseUrl: string;
  token?: string;
}

export interface LiveTelemetryDeps {
  store: TelemetryStore;
  /** Build a durable telemetry stream for an endpoint (injected for tests). */
  createStream: (endpoint: TelemetryEndpoint) => TelemetryStream;
}

export class LiveTelemetry {
  private readonly store: TelemetryStore;
  private readonly createStream: (endpoint: TelemetryEndpoint) => TelemetryStream;

  private stream: TelemetryStream | null = null;
  private subscriptions: Disposable[] = [];

  constructor(deps: LiveTelemetryDeps) {
    this.store = deps.store;
    this.createStream = deps.createStream;
  }

  /**
   * Point the telemetry feed at a supervisor: tear down any prior stream, build a
   * new one, subscribe its events into the store, and start it.
   */
  connect(endpoint: TelemetryEndpoint): void {
    this.disconnect();
    const stream = this.createStream(endpoint);
    this.stream = stream;
    this.subscriptions.push(stream.onEvent((op) => this.store.addOperation(op)));
    this.subscriptions.push(stream.onStatus((status) => this.store.setStreamStatus(status)));
    stream.start();
  }

  /** Tear down the stream, keeping the store's accumulated rollups. */
  disconnect(): void {
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions = [];
    if (this.stream) {
      this.stream.dispose();
      this.stream = null;
    }
  }

  dispose(): void {
    this.disconnect();
  }
}
