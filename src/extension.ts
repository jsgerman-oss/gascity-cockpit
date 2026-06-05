/**
 * VS Code activation glue for the GasCity Cockpit.
 *
 * Intentionally thin (PRD: the editor-bound layer is kept small and excluded
 * from heavy unit testing). It maps VS Code settings + workspace to the
 * `vscode`-free discovery/resilience core, drives a status-bar indicator and an
 * output channel, and exposes reconnect / show-status / check-connection
 * commands. All the logic worth testing lives behind `./discovery` and `./api`.
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
} from './discovery/index.ts';
import {
  checkApiCompatibility,
  createCockpitClient,
  PINNED_API_VERSION,
} from './api/index.ts';

const CONFIG_SECTION = 'gascityCockpit';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('GasCity Cockpit', { log: true });
  context.subscriptions.push(output);

  const log: Logger = (level, message, meta) => {
    const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    writeLog(output, level, `${message}${suffix}`);
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = `${CONFIG_SECTION}.showStatus`;
  context.subscriptions.push(statusBar);

  let manager = createManager(log);
  let lastStatus: ConnectionStatus = manager.status;
  const subscribe = (m: ConnectionManager) =>
    m.onDidChangeStatus((status) => {
      lastStatus = status;
      renderStatusBar(statusBar, status);
      if (status.restarted) {
        log('info', 'supervisor restarted — downstream consumers should resubscribe');
      }
    });
  let statusSub = subscribe(manager);
  renderStatusBar(statusBar, manager.status);
  statusBar.show();
  manager.start();
  log('info', `GasCity Cockpit active — typed client pinned to /v0 contract ${PINNED_API_VERSION}`);

  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG_SECTION}.reconnect`, () => {
      log('info', 'manual reconnect requested');
      manager.reconnect();
    }),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.showStatus`, async () => {
      output.show(true);
      const s = lastStatus;
      const where = s.endpoint ? `${s.endpoint.baseUrl} (${s.endpoint.source})` : 'no endpoint';
      const choice = await vscode.window.showInformationMessage(
        `GasCity Cockpit: ${s.state} — ${s.detail}\n${where}`,
        'Reconnect',
      );
      if (choice === 'Reconnect') manager.reconnect();
    }),
    // Run the typed /v0 client against the currently-resolved endpoint and
    // report version compatibility. The client is the seam feature beads build
    // on; this command exercises it and surfaces contract drift.
    vscode.commands.registerCommand(`${CONFIG_SECTION}.checkConnection`, async () => {
      const endpoint = lastStatus.endpoint;
      const baseUrl = endpoint?.baseUrl ?? DEFAULT_SUPERVISOR_BASE_URL;
      output.show(true);
      log('info', `checking /v0 compatibility at ${baseUrl} (client pinned to ${PINNED_API_VERSION})`);
      const client = createCockpitClient({
        baseUrl,
        timeoutMs: 3000,
        ...(endpoint?.token ? { headers: { Authorization: `Bearer ${endpoint.token}` } } : {}),
      });
      const compat = await checkApiCompatibility(client);
      log(compat.ok ? 'info' : 'warn', `${compat.status}: ${compat.message}`);
      if (compat.error?.requestId) log('info', `request id: ${compat.error.requestId}`);
      if (compat.status === 'unreachable' || compat.status === 'mismatch') {
        const choice = await vscode.window.showWarningMessage(compat.message, 'Show Log');
        if (choice === 'Show Log') output.show(true);
      } else {
        void vscode.window.showInformationMessage(compat.message);
      }
    }),
    // Rebuild the manager when relevant settings change (poll/backoff are fixed
    // at construction, so we recreate rather than just reconnect).
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) return;
      log('info', 'configuration changed — rebuilding connection');
      statusSub.dispose();
      manager.dispose();
      manager = createManager(log);
      statusSub = subscribe(manager);
      manager.start();
    }),
    // Re-discover when the set of open folders changes (a city may have opened).
    vscode.workspace.onDidChangeWorkspaceFolders(() => manager.reconnect()),
    { dispose: () => manager.dispose() },
  );
}

export function deactivate(): void {
  // Disposables registered on context.subscriptions handle teardown.
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
