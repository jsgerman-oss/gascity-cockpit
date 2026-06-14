/**
 * VS Code glue for D4b — the `gascityCockpit.ghostex.proxySession` command:
 * proxy a *gas-city-owned* agent session into a Ghostex pane (display + attach).
 * Pure vscode glue (PRD: thin editor layer, excluded from coverage) — every
 * testable bit lives behind vscode-free seams: the mirror state machine in
 * `../ghostex/agentProxy.ts`, the gas-city transcript in `../chat/conversation-store.ts`.
 * This is the reverse-direction mirror of D4a's `../chat/open-ghostex-chat.ts`.
 *
 * Wiring: a {@link ConversationStore} owns the gas-city session (the source of
 * truth gas-city *hosts*); a {@link GhostexSessionProxy} subscribes to its
 * transcript and mirrors it into a Ghostex terminal pane via `sendSessionText`,
 * then `focusSession` reveals it. The operator keeps driving the agent through
 * gas-city; Ghostex is an attached window onto it.
 */
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { bearerAuthHeader, createCockpitClient } from '../api/index.ts';
import { DEFAULT_SUPERVISOR_BASE_URL } from '../discovery/index.ts';
import {
  discoverGhostex,
  GhostexSessionProxy,
  GxClient,
  type GhostexDiscoveryInputs,
  type ProxySourceSubscribe,
} from '../ghostex/index.ts';
import { ConversationStore } from '../chat/conversation-store.ts';
import { pickCity, pickSession } from '../chat/open-chat.ts';
import { CONFIG_SECTION, type FeatureHost } from '../host/index.ts';

const CMD_PROXY_SESSION = 'gascityCockpit.ghostex.proxySession';

/** Register the proxy-session command. Called from the Ghostex feature. */
export function registerGhostexProxy(host: FeatureHost): void {
  host.context.subscriptions.push(
    vscode.commands.registerCommand(
      CMD_PROXY_SESSION,
      (preset?: { cityName?: string; sessionId?: string }) => proxySession(host, preset),
    ),
  );
}

/** Pick a gas-city session + a Ghostex project, then proxy one into the other. */
async function proxySession(
  host: FeatureHost,
  preset?: { cityName?: string; sessionId?: string },
): Promise<void> {
  // 1. The gas-city-owned session (the source gas-city hosts).
  const endpoint = host.getEndpoint();
  const baseUrl = endpoint?.baseUrl ?? DEFAULT_SUPERVISOR_BASE_URL;
  const token = endpoint?.token ?? null;
  const client = createCockpitClient({ baseUrl, timeoutMs: 5000, headers: bearerAuthHeader(token) });

  const cityName = preset?.cityName ?? (await pickCity(client, host.log));
  if (!cityName) return;
  const sessionId = preset?.sessionId ?? (await pickSession(client, cityName, host.log));
  if (!sessionId) return;

  // 2. The Ghostex pane (the display surface).
  const discovery = await discoverGhostex(discoveryInputs());
  if (discovery.state !== 'connected') {
    void vscode.window.showWarningMessage(`Ghostex: ${discovery.detail}`);
    return;
  }
  const gx = GxClient.rpc({ baseUrl: discovery.endpoint.baseUrl, token: discovery.endpoint.token });
  const projectId = await pickProject(gx, host);
  if (!projectId) return;

  // 3. Mirror the gas-city transcript into the proxy pane. The ConversationStore
  //    is the source of truth; the proxy reflects each of its states onto Ghostex.
  const subscribe: ProxySourceSubscribe = (onSnapshot) => {
    const source = new ConversationStore({ client, endpoint: { baseUrl, token }, cityName, sessionId });
    const sub = source.onDidChange((st) =>
      onSnapshot({
        turns: st.turns,
        activity: st.activity,
        title: st.title,
        ended: st.connection === 'closed',
      }),
    );
    void source.start();
    return {
      dispose: () => {
        sub.dispose();
        source.dispose();
      },
    };
  };

  const proxy = new GhostexSessionProxy({ gx, projectId, source: { cityName, sessionId }, subscribe });
  host.context.subscriptions.push({ dispose: () => proxy.dispose() });

  await proxy.start();
  if (proxy.state.connection === 'error') {
    void vscode.window.showWarningMessage(`Ghostex proxy: ${proxy.state.lastError ?? 'could not create the pane'}`);
    return;
  }
  await proxy.reveal();
  void vscode.window.showInformationMessage(`Proxying ${cityName}/${sessionId} into Ghostex.`);
}

/** Pick the Ghostex project to host the proxy pane (auto-selects a lone project). */
async function pickProject(gx: GxClient, host: FeatureHost): Promise<string | undefined> {
  let projects;
  try {
    projects = await gx.listProjects();
  } catch (err) {
    host.log('warn', 'ghostex proxy: could not list projects', { error: String(err) });
    void vscode.window.showWarningMessage(`Ghostex: couldn't list projects — ${(err as Error).message}`);
    return undefined;
  }
  if (projects.length === 0) {
    void vscode.window.showInformationMessage('Ghostex: no projects to host the proxy pane.');
    return undefined;
  }
  if (projects.length === 1) {
    return projects[0]?.projectId;
  }
  const items = projects.map((p) => ({
    label: p.name,
    description: p.path ?? p.projectId,
    id: p.projectId,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Ghostex: Proxy gas-city Session',
    placeHolder: 'Select a Ghostex project to host the proxy pane',
    matchOnDescription: true,
  });
  return pick?.id;
}

// --- config helpers (mirror ghostexExplorer's discovery inputs) --------------

function discoveryInputs(): GhostexDiscoveryInputs {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const url = cfg.get<string>('ghostex.gxserverUrl', '').trim();
  const token = cfg.get<string>('ghostex.gxserverToken', '').trim();
  return {
    settingsUrl: url || null,
    settingsToken: token || null,
    readTokenFile: (path) => readFile(expandHome(path), 'utf8'),
  };
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~(?=$|[/\\])/, homedir()) : p;
}
