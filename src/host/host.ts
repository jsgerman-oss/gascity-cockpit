/**
 * The cockpit's connection core — everything `extension.ts` used to do inline,
 * minus the per-feature wiring.
 *
 * It owns the supervisor `ConnectionManager`, the status-bar indicator, the
 * output channel + logger, the live typed client, and the shared beads
 * repository, and it exposes them to features through a {@link FeatureHost}.
 * Features react to connection changes via {@link FeatureHost.onStatusChange}
 * rather than by editing a central fan-out, so this file does not change when a
 * feature is added (cockpit-1ll.15).
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import { readFile } from 'node:fs/promises';
import {
  ConnectionManager,
  DEFAULT_SUPERVISOR_BASE_URL,
  cityDescriptorPath,
  machineDescriptorPath,
  probeHealth,
  resolveEndpoint,
  type ApiEndpoint,
  type ConnectionStatus,
  type DiscoveryInputs,
  type LogLevel,
  type Logger,
} from '../discovery/index.ts';
import {
  bearerAuthHeader,
  checkApiCompatibility,
  createCockpitClient,
  PINNED_API_VERSION,
  type CockpitClient,
} from '../api/index.ts';
import { BeadsRepository } from '../beads/index.ts';
import { CONFIG_SECTION, type ClientEndpoint, type FeatureHost, type StatusListener } from './types.ts';

/** Default per-request timeout for clients the host builds. */
const DEFAULT_TIMEOUT_MS = 5000;
/** Tighter timeout for the on-demand compatibility check. */
const CHECK_TIMEOUT_MS = 3000;

interface StatusChange {
  status: ConnectionStatus;
  prevState: ConnectionStatus['state'] | null;
}

/** A built host plus the deferred `start` that kicks off the connection. */
export interface CockpitHostHandle {
  host: FeatureHost;
  /** Begin discovery/polling. Call after every feature has subscribed. */
  start(): void;
}

/**
 * Build the connection core and the {@link FeatureHost} over it. Registers the
 * core commands (reconnect / show-status / check-connection) and the settings +
 * workspace reactions on `context.subscriptions`. The connection is not started
 * until the returned `start()` runs, so features can subscribe first.
 */
export function createCockpitHost(context: vscode.ExtensionContext): CockpitHostHandle {
  const host = new CockpitHost(context);
  return { host, start: () => host.start() };
}

class CockpitHost implements FeatureHost {
  readonly context: vscode.ExtensionContext;
  readonly log: Logger;
  readonly repository: BeadsRepository;

  private readonly output: vscode.LogOutputChannel;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly emitter = new vscode.EventEmitter<StatusChange>();

  private manager: ConnectionManager;
  private statusSub: vscode.Disposable;
  private lastStatus: ConnectionStatus;
  private currentClient: CockpitClient | null = null;
  private prevState: ConnectionStatus['state'] | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    this.output = vscode.window.createOutputChannel('GasCity Cockpit', { log: true });
    context.subscriptions.push(this.output);
    this.log = (level, message, meta) => {
      const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      writeLog(this.output, level, `${message}${suffix}`);
    };

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = `${CONFIG_SECTION}.showStatus`;
    context.subscriptions.push(this.statusBar);

    // Features talk to whatever supervisor is currently connected through this
    // mutable client, kept in sync with the manager by `fan`.
    this.repository = new BeadsRepository({ getClient: () => this.currentClient });

    this.manager = createManager(this.log);
    this.lastStatus = this.manager.status;
    this.statusSub = this.manager.onDidChangeStatus((status) => this.fan(status));

    this.registerCoreCommands();
    context.subscriptions.push(
      this.emitter,
      // Dispose whichever manager subscription is current (it is swapped on rebuild).
      { dispose: () => this.statusSub.dispose() },
      { dispose: () => this.manager.dispose() },
    );
  }

  // --- FeatureHost surface ---------------------------------------------------

  getClient(): CockpitClient | null {
    return this.currentClient;
  }

  getEndpoint(): ApiEndpoint | null {
    return this.lastStatus.endpoint ?? null;
  }

  getStatus(): ConnectionStatus {
    return this.lastStatus;
  }

  createClient(endpoint: ClientEndpoint, timeoutMs: number = DEFAULT_TIMEOUT_MS): CockpitClient {
    return createCockpitClient({
      baseUrl: endpoint.baseUrl,
      timeoutMs,
      headers: bearerAuthHeader(endpoint.token),
    });
  }

  onStatusChange(listener: StatusListener): vscode.Disposable {
    return this.emitter.event((e) => listener(e.status, e.prevState));
  }

  reconnect(): void {
    this.manager.reconnect();
  }

  showOutput(): void {
    this.output.show(true);
  }

  // --- Lifecycle -------------------------------------------------------------

  start(): void {
    renderStatusBar(this.statusBar, this.manager.status);
    this.statusBar.show();
    this.manager.start();
    this.log('info', `GasCity Cockpit active — typed client pinned to /v0 contract ${PINNED_API_VERSION}`);
  }

  /** Recompute derived state, render the indicator, then fan out to features. */
  private fan(status: ConnectionStatus): void {
    this.lastStatus = status;
    this.currentClient = clientFromStatus(status, (ep) => this.createClient(ep));
    renderStatusBar(this.statusBar, status);
    if (status.restarted) {
      this.log('info', 'supervisor restarted — downstream consumers should resubscribe');
    }
    this.emitter.fire({ status, prevState: this.prevState });
    this.prevState = status.state;
  }

  /** Rebuild the manager after an `api.*` settings change; feature subs persist. */
  private rebuildManager(): void {
    this.statusSub.dispose();
    this.manager.dispose();
    this.prevState = null; // force the rebuilt manager's first connect to read as a transition
    this.manager = createManager(this.log);
    this.statusSub = this.manager.onDidChangeStatus((status) => this.fan(status));
    this.manager.start();
  }

  private registerCoreCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand(`${CONFIG_SECTION}.reconnect`, () => {
        this.log('info', 'manual reconnect requested');
        this.manager.reconnect();
      }),
      vscode.commands.registerCommand(`${CONFIG_SECTION}.showStatus`, async () => {
        this.output.show(true);
        const s = this.lastStatus;
        const where = s.endpoint ? `${s.endpoint.baseUrl} (${s.endpoint.source})` : 'no endpoint';
        const choice = await vscode.window.showInformationMessage(
          `GasCity Cockpit: ${s.state} — ${s.detail}\n${where}`,
          'Reconnect',
        );
        if (choice === 'Reconnect') this.manager.reconnect();
      }),
      // Run the typed /v0 client against the currently-resolved endpoint and
      // report version compatibility — exercises the seam features build on.
      vscode.commands.registerCommand(`${CONFIG_SECTION}.checkConnection`, async () => {
        const endpoint = this.lastStatus.endpoint;
        const baseUrl = endpoint?.baseUrl ?? DEFAULT_SUPERVISOR_BASE_URL;
        this.output.show(true);
        this.log('info', `checking /v0 compatibility at ${baseUrl} (client pinned to ${PINNED_API_VERSION})`);
        const client = this.createClient({ baseUrl, token: endpoint?.token }, CHECK_TIMEOUT_MS);
        const compat = await checkApiCompatibility(client);
        this.log(compat.ok ? 'info' : 'warn', `${compat.status}: ${compat.message}`);
        if (compat.error?.requestId) this.log('info', `request id: ${compat.error.requestId}`);
        if (compat.status === 'unreachable' || compat.status === 'mismatch') {
          const choice = await vscode.window.showWarningMessage(compat.message, 'Show Log');
          if (choice === 'Show Log') this.output.show(true);
        } else {
          void vscode.window.showInformationMessage(compat.message);
        }
      }),
      // API settings (poll/backoff are fixed at construction) require recreating
      // the manager; feature-owned settings (e.g. dashboard.url) are handled by
      // the owning feature's own configuration listener.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG_SECTION}.api`)) {
          this.log('info', 'API configuration changed — rebuilding connection');
          this.rebuildManager();
        }
      }),
      // Re-discover when the set of open folders changes (a city may have opened).
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.manager.reconnect()),
    );
  }
}

/** Build a typed client for the current endpoint, or null when unusable. */
function clientFromStatus(
  status: ConnectionStatus,
  build: (endpoint: ClientEndpoint) => CockpitClient,
): CockpitClient | null {
  const endpoint = status.endpoint;
  if (!endpoint || status.state === 'unavailable' || status.state === 'idle') return null;
  return build({ baseUrl: endpoint.baseUrl, token: endpoint.token });
}

function createManager(log: Logger): ConnectionManager {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const pollSeconds = Math.max(2, cfg.get<number>('api.healthPollSeconds', 10));
  const baseDelayMs = Math.max(50, cfg.get<number>('api.reconnect.baseDelayMs', 500));
  const maxDelayMs = Math.max(baseDelayMs, cfg.get<number>('api.reconnect.maxDelayMs', 15_000));

  return new ConnectionManager({
    discover: () => resolveEndpoint(buildDiscoveryInputs(log)),
    probe: (endpoint: ApiEndpoint) => probeHealth(endpoint.baseUrl, { token: endpoint.token, timeoutMs: 3000 }),
    log,
    options: { pollIntervalMs: pollSeconds * 1000, baseDelayMs, maxDelayMs },
  });
}

function buildDiscoveryInputs(log: Logger): DiscoveryInputs {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const settingsUrl = (cfg.get<string>('api.url', '') || '').trim() || null;
  const settingsToken = (cfg.get<string>('api.token', '') || '').trim() || null;

  // Machine-wide supervisor descriptor first, then any open city's descriptor.
  const descriptorPaths = [machineDescriptorPath(os.homedir())];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file') descriptorPaths.push(cityDescriptorPath(folder.uri.fsPath));
  }

  return {
    settingsUrl,
    settingsToken,
    descriptorPaths,
    defaultBaseUrl: DEFAULT_SUPERVISOR_BASE_URL,
    readFile: (path) => readFile(path, 'utf8'),
    probe: (baseUrl, token) => probeHealth(baseUrl, { token, timeoutMs: 3000 }),
    log,
  };
}

interface StatusBarLook {
  icon: string;
  label: string;
  background?: vscode.ThemeColor;
}

function statusBarLook(status: ConnectionStatus): StatusBarLook {
  switch (status.state) {
    case 'connected':
      return { icon: '$(broadcast)', label: 'GasCity' };
    case 'degraded':
      return { icon: '$(loading~spin)', label: 'GasCity: starting' };
    case 'discovering':
    case 'connecting':
      return { icon: '$(loading~spin)', label: 'GasCity: connecting' };
    case 'reconnecting':
      return {
        icon: '$(warning)',
        label: 'GasCity: reconnecting',
        background: new vscode.ThemeColor('statusBarItem.warningBackground'),
      };
    case 'unavailable':
      return {
        icon: '$(error)',
        label: 'GasCity: API unavailable',
        background: new vscode.ThemeColor('statusBarItem.errorBackground'),
      };
    case 'idle':
    default:
      return { icon: '$(circle-slash)', label: 'GasCity: off' };
  }
}

function renderStatusBar(item: vscode.StatusBarItem, status: ConnectionStatus): void {
  const look = statusBarLook(status);
  item.text = `${look.icon} ${look.label}`;
  item.backgroundColor = look.background;
  const lines = [
    `GasCity Cockpit — ${status.state}`,
    status.detail,
    status.endpoint ? `Endpoint: ${status.endpoint.baseUrl} (${status.endpoint.source})` : 'Endpoint: (none)',
  ];
  if (status.health) lines.push(`Server: ${status.health.version} · ${status.health.build_id}`);
  item.tooltip = lines.join('\n');
}

function writeLog(output: vscode.LogOutputChannel, level: LogLevel, message: string): void {
  switch (level) {
    case 'debug':
      output.debug(message);
      break;
    case 'info':
      output.info(message);
      break;
    case 'warn':
      output.warn(message);
      break;
    case 'error':
      output.error(message);
      break;
  }
}
