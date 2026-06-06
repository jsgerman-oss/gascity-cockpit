/**
 * A reusable in-memory testbed for the host-abstracted cockpit features.
 *
 * The 11 features under `src/features/` that depend on the `host` interface
 * (not `vscode` directly) are written against {@link FeatureHost}: they take the
 * shared services — `context`, `repository`, `getClient`, `log`, `onStatusChange`
 * — and wire their `src/views/` glue onto them. This module builds a fake of that
 * host plus the recording {@link file://./fake-vscode.ts} `vscode` stand-in, so a
 * feature's `activate()` can run in plain Node and its commands, views, and
 * status reactions can be driven and asserted — no editor runtime.
 *
 * Usage:
 * ```ts
 * import beadsFeature from "../features/beads.feature.ts";
 * import { createTestbed } from "../test/fake-host.ts";
 *
 * const tb = createTestbed();          // resets the fake vscode, builds a host
 * tb.activate(beadsFeature);           // runs the feature's register() glue
 * expect(tb.hasCommand("gascityCockpit.beads.refresh")).toBe(true);
 * tb.emitStatus("connected");          // fan out a connection change
 * await tb.invokeCommand("gascityCockpit.beads.copyId", node);
 * ```
 *
 * Each {@link createTestbed} call resets the fake `vscode` recorder, so one
 * testbed per test gives clean isolation.
 */
import type * as vscode from "vscode";
import type { CockpitClient } from "../api/index.ts";
import { BeadsRepository } from "../beads/index.ts";
import type {
  ApiEndpoint,
  ConnectionState,
  ConnectionStatus,
  Logger,
  LogLevel,
} from "../discovery/index.ts";
import type {
  ClientEndpoint,
  CockpitFeature,
  FeatureHost,
  StatusListener,
} from "../host/index.ts";
import {
  EventEmitter,
  Uri,
  fakeVscodeState,
  queueInputBox,
  queueMessageResponse,
  queueQuickPick,
  resetFakeVscode,
  type FakeStatusBarItem,
  type FakeVscodeState,
  type RegisteredTreeView,
  type ShownMessage,
  type TextDocumentContentProviderLike,
  type TreeDataProviderLike,
} from "./fake-vscode.ts";

const DEFAULT_ENDPOINT: ApiEndpoint = {
  baseUrl: "http://127.0.0.1:8372",
  token: null,
  mode: "supervisor",
  source: "default",
};

/**
 * Build a {@link ConnectionStatus}. Pass a full status through unchanged, or a
 * bare {@link ConnectionState} to get a sensible default (a `connected`/`degraded`
 * state gets the default endpoint; everything else gets none) with per-field
 * overrides.
 */
export function makeStatus(
  stateOrStatus: ConnectionState | ConnectionStatus,
  overrides: Partial<ConnectionStatus> = {},
): ConnectionStatus {
  if (typeof stateOrStatus !== "string") return stateOrStatus;
  const connectedish = stateOrStatus === "connected" || stateOrStatus === "degraded";
  return {
    state: stateOrStatus,
    endpoint: "endpoint" in overrides ? (overrides.endpoint ?? null) : connectedish ? DEFAULT_ENDPOINT : null,
    health: overrides.health ?? null,
    failedAttempts: overrides.failedAttempts ?? 0,
    detail: overrides.detail ?? stateOrStatus,
    restarted: overrides.restarted ?? false,
  };
}

/** A captured `host.log(...)` call. */
export interface LogEntry {
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

interface FakeHostOptions {
  initialStatus: ConnectionStatus;
  client: CockpitClient | null;
  repository?: BeadsRepository;
  createClient?: (endpoint: ClientEndpoint, timeoutMs?: number) => CockpitClient;
}

/**
 * A {@link FeatureHost} backed by in-memory state, with test affordances. Mirrors
 * the real host's status fan-out: listeners receive the new status and the
 * previous state (`null` on the first event), so transition logic — the
 * `prevState !== 'connected'` reload guards features use — exercises correctly.
 */
class FakeFeatureHost implements FeatureHost {
  readonly context: vscode.ExtensionContext;
  readonly repository: BeadsRepository;
  readonly log: Logger;
  readonly logs: LogEntry[] = [];

  reconnectCount = 0;
  showOutputCount = 0;

  private listeners: StatusListener[] = [];
  private status: ConnectionStatus;
  private prevState: ConnectionState | null = null;
  private client: CockpitClient | null;
  private readonly clientFactory: (endpoint: ClientEndpoint, timeoutMs?: number) => CockpitClient;

  constructor(opts: FakeHostOptions) {
    this.status = opts.initialStatus;
    this.client = opts.client;
    this.repository = opts.repository ?? new BeadsRepository({ getClient: () => this.client });
    this.context = makeExtensionContext();
    this.log = (level, message, meta) => {
      this.logs.push(meta ? { level, message, meta } : { level, message });
    };
    this.clientFactory =
      opts.createClient ??
      (() => {
        throw new Error("FakeFeatureHost.createClient() was called but no createClient was configured on the testbed");
      });
  }

  getClient(): CockpitClient | null {
    return this.client;
  }

  getEndpoint(): ApiEndpoint | null {
    return this.status.endpoint;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  createClient(endpoint: ClientEndpoint, timeoutMs?: number): CockpitClient {
    return this.clientFactory(endpoint, timeoutMs);
  }

  onStatusChange(listener: StatusListener): vscode.Disposable {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  }

  reconnect(): void {
    this.reconnectCount += 1;
  }

  showOutput(): void {
    this.showOutputCount += 1;
  }

  // --- test driver (not part of FeatureHost) --------------------------------

  setClient(client: CockpitClient | null): void {
    this.client = client;
  }

  /** Set the current status without firing listeners. */
  setStatus(status: ConnectionStatus): void {
    this.status = status;
  }

  /** Set the current status and fan it out to every listener with prevState. */
  fire(status: ConnectionStatus): void {
    this.status = status;
    const prev = this.prevState;
    for (const listener of [...this.listeners]) listener(status, prev);
    this.prevState = status.state;
  }

  listenerCount(): number {
    return this.listeners.length;
  }
}

/** In-memory {@link vscode.Memento} (globalState / workspaceState). */
function makeMemento(): unknown {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
    update: (key: string, value: unknown) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    setKeysForSync: () => undefined,
  };
}

/**
 * A minimal {@link vscode.ExtensionContext}: a real `subscriptions` array and
 * working in-memory mementos (a feature like the beads explorer reads
 * `globalState` at registration), with the rest stubbed and cast — features only
 * touch `subscriptions`, `globalState`, and `workspaceState`.
 */
function makeExtensionContext(): vscode.ExtensionContext {
  const ctx = {
    subscriptions: [] as Array<{ dispose(): unknown }>,
    globalState: makeMemento(),
    workspaceState: makeMemento(),
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      onDidChange: new EventEmitter<unknown>().event,
    },
    extensionUri: Uri.file("/fake/extension"),
    extensionPath: "/fake/extension",
    asAbsolutePath: (relative: string) => `/fake/extension/${relative}`,
    storageUri: Uri.file("/fake/storage"),
    globalStorageUri: Uri.file("/fake/global-storage"),
    logUri: Uri.file("/fake/log"),
    extensionMode: 2,
    environmentVariableCollection: {},
    extension: { id: "gastown.gascity-cockpit", isActive: true, packageJSON: {} },
    languageModelAccessInformation: {},
  };
  return ctx as unknown as vscode.ExtensionContext;
}

/** The handle a test drives a feature through. See module docs for usage. */
export interface Testbed {
  /** The fake host passed to `feature.activate`. */
  readonly host: FakeFeatureHost;
  /** The fake `ExtensionContext` (its `subscriptions` collect feature disposables). */
  readonly context: vscode.ExtensionContext;
  /** The beads repository the host exposes (real `BeadsRepository` over the testbed client). */
  readonly repository: BeadsRepository;
  /** The live `vscode` recorder, for assertions beyond the convenience helpers. */
  readonly state: FakeVscodeState;

  /** Run a feature's `activate()` against the host (its register() glue runs here). */
  activate(feature: CockpitFeature): void;
  /** Activate several features in order (e.g. the whole `FEATURES` registry). */
  activateAll(features: readonly CockpitFeature[]): void;
  /** Dispose everything the features pushed onto `context.subscriptions`. */
  disposeAll(): void;

  /** Fan out a connection-status change (string state or full status) and return what was fired. */
  emitStatus(stateOrStatus: ConnectionState | ConnectionStatus, overrides?: Partial<ConnectionStatus>): ConnectionStatus;
  /** Set the current status without firing listeners. */
  setStatus(stateOrStatus: ConnectionState | ConnectionStatus, overrides?: Partial<ConnectionStatus>): ConnectionStatus;
  /** Set the client `getClient()` returns. */
  setClient(client: CockpitClient | null): void;

  /** Every registered command id. */
  commandIds(): string[];
  /** Whether a command id is registered. */
  hasCommand(id: string): boolean;
  /** Invoke a registered command and await its result. Throws if unregistered. */
  invokeCommand(id: string, ...args: unknown[]): Promise<unknown>;

  /** A registered tree view by its view id. */
  getView(viewId: string): RegisteredTreeView | undefined;
  /** The tree-data provider for a view id. */
  getTreeProvider(viewId: string): TreeDataProviderLike | undefined;
  /** The text-document content provider for a scheme. */
  getContentProvider(scheme: string): TextDocumentContentProviderLike | undefined;
  /** Every created status-bar item. */
  statusBarItems(): FakeStatusBarItem[];
  /** The feature disposables pushed onto `context.subscriptions`. */
  subscriptions(): Array<{ dispose(): unknown }>;

  /** `window.showInformationMessage` calls, in order. */
  infoMessages(): ShownMessage[];
  /** `window.showWarningMessage` calls, in order. */
  warnMessages(): ShownMessage[];
  /** `window.showErrorMessage` calls, in order. */
  errorMessages(): ShownMessage[];
  /** Captured `host.log(...)` calls. */
  logs(): LogEntry[];

  /** Queue the next `show*Message` return value(s) (the chosen item). */
  queueMessage(...values: unknown[]): void;
  /** Queue the next `showQuickPick` return value(s) (the chosen item). */
  queueQuickPick(...values: unknown[]): void;
  /** Queue the next `showInputBox` return value(s). */
  queueInput(...values: Array<string | undefined>): void;

  /** Drain pending micro/macrotasks (await after firing a status that triggers async refresh). */
  flush(): Promise<void>;
}

export interface TestbedOptions {
  /** Initial connection status (default: `idle`). */
  status?: ConnectionState | ConnectionStatus;
  /** Initial client `getClient()` returns (default: `null`). */
  client?: CockpitClient | null;
  /** Inject a repository (default: a real `BeadsRepository` over the testbed client). */
  repository?: BeadsRepository;
  /** Implement `host.createClient` (default: throws if a feature calls it). */
  createClient?: (endpoint: ClientEndpoint, timeoutMs?: number) => CockpitClient;
}

/**
 * Build a testbed. Resets the fake `vscode` recorder, then constructs a host over
 * fresh in-memory state. One testbed per test keeps recorded state isolated.
 */
export function createTestbed(options: TestbedOptions = {}): Testbed {
  resetFakeVscode();

  const host = new FakeFeatureHost({
    initialStatus:
      options.status === undefined
        ? makeStatus("idle")
        : makeStatus(options.status),
    client: options.client ?? null,
    repository: options.repository,
    createClient: options.createClient,
  });

  const st = (): FakeVscodeState => fakeVscodeState();

  return {
    host,
    context: host.context,
    repository: host.repository,
    get state() {
      return st();
    },

    activate(feature) {
      feature.activate(host);
    },
    activateAll(features) {
      for (const feature of features) feature.activate(host);
    },
    disposeAll() {
      // Dispose in reverse registration order, mirroring VS Code teardown.
      for (const sub of [...host.context.subscriptions].reverse()) {
        try {
          sub.dispose();
        } catch {
          // A feature's dispose throwing must not mask the rest of teardown.
        }
      }
    },

    emitStatus(stateOrStatus, overrides) {
      const status = makeStatus(stateOrStatus, overrides);
      host.fire(status);
      return status;
    },
    setStatus(stateOrStatus, overrides) {
      const status = makeStatus(stateOrStatus, overrides);
      host.setStatus(status);
      return status;
    },
    setClient(client) {
      host.setClient(client);
    },

    commandIds() {
      return [...st().commands.keys()];
    },
    hasCommand(id) {
      return st().commands.has(id);
    },
    async invokeCommand(id, ...args) {
      const handler = st().commands.get(id);
      if (!handler) {
        throw new Error(`No command registered with id "${id}". Registered: ${[...st().commands.keys()].join(", ") || "(none)"}`);
      }
      return await Promise.resolve(handler(...args));
    },

    getView(viewId) {
      return st().treeViews.get(viewId);
    },
    getTreeProvider(viewId) {
      return st().treeViews.get(viewId)?.provider;
    },
    getContentProvider(scheme) {
      return st().contentProviders.get(scheme);
    },
    statusBarItems() {
      return st().statusBarItems;
    },
    subscriptions() {
      return host.context.subscriptions as unknown as Array<{ dispose(): unknown }>;
    },

    infoMessages() {
      return st().infoMessages;
    },
    warnMessages() {
      return st().warnMessages;
    },
    errorMessages() {
      return st().errorMessages;
    },
    logs() {
      return host.logs;
    },

    queueMessage(...values) {
      queueMessageResponse(...values);
    },
    queueQuickPick(...values) {
      queueQuickPick(...values);
    },
    queueInput(...values) {
      queueInputBox(...values);
    },

    flush() {
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}
