/**
 * Thin `vscode` glue for the Ghostex session-driving commands
 * (`gascityCockpit.ghostex.*`). It gathers operator input (project/session
 * quickpicks, text/title input boxes, context-menu nodes), builds a
 * {@link GxClient}, and delegates every operation to the `vscode`-free
 * {@link SessionDriver} — where the orchestration, validation, and two-phase
 * agent-rename live and are unit-tested. Like `src/views/ghostex.ts`, this layer
 * is intentionally untested glue: its logic is the cores it calls.
 *
 * Transport: per the integration decision (D1), commands default to the `gx`
 * **CLI** (stable public contract, handles auth/remote for us). Set
 * `gascityCockpit.ghostex.commandTransport` to `rpc` to drive the gxserver
 * daemon directly instead.
 *
 * Context menus: the Sessions explorer (a sibling feature) attaches these to its
 * session rows. The contract is the `contextValue` prefix `ghostexSession` and a
 * node exposing `sessionId`/`projectId` (directly or under `.session`) — see
 * {@link resolveSessionTarget}. Every command is also runnable from the Command
 * Palette, falling back to a session quickpick when invoked without a node.
 */
import * as vscode from 'vscode';
import {
  DEFAULT_GXSERVER_BASE_URL,
  GxClient,
  type GhostexProject,
  type GhostexSession,
} from '../ghostex/index.ts';
import { resolveSessionTarget, SessionDriver, type GhostexSessionTarget } from '../ghostex/drive.ts';
import { CONFIG_SECTION, type FeatureHost } from '../host/index.ts';

/** `contextValue` prefix the Sessions tree sets on session rows for these menus. */
export const GHOSTEX_SESSION_CONTEXT = 'ghostexSession';

const CMD = {
  createSession: 'gascityCockpit.ghostex.createSession',
  createAgentSession: 'gascityCockpit.ghostex.createAgentSession',
  renameSession: 'gascityCockpit.ghostex.renameSession',
  focusSession: 'gascityCockpit.ghostex.focusSession',
  sleepSession: 'gascityCockpit.ghostex.sleepSession',
  wakeSession: 'gascityCockpit.ghostex.wakeSession',
  killSession: 'gascityCockpit.ghostex.killSession',
  sendText: 'gascityCockpit.ghostex.sendText',
  sendMessage: 'gascityCockpit.ghostex.sendMessage',
  readText: 'gascityCockpit.ghostex.readText',
} as const;

/** Register the `gascityCockpit.ghostex.*` drive commands onto the host. */
export function registerGhostexCommands(host: FeatureHost): void {
  const command = (id: string, handler: (arg: unknown) => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(id, (arg?: unknown) => void guard(host, handler, arg));

  host.context.subscriptions.push(
    command(CMD.createSession, () => createTerminalSession()),
    command(CMD.createAgentSession, () => createAgentSession()),
    command(CMD.renameSession, (arg) => renameSession(arg)),
    command(CMD.focusSession, (arg) => runLifecycle(arg, 'focus', 'Revealed')),
    command(CMD.sleepSession, (arg) => runLifecycle(arg, 'sleep', 'Sleeping')),
    command(CMD.wakeSession, (arg) => runLifecycle(arg, 'wake', 'Awake')),
    command(CMD.killSession, (arg) => killSession(arg)),
    command(CMD.sendText, (arg) => sendToSession(arg, 'text')),
    command(CMD.sendMessage, (arg) => sendToSession(arg, 'message')),
    command(CMD.readText, (arg) => readSessionText(arg)),
  );
}

/** Run a command handler, surfacing any failure as a notification + log line. */
async function guard(host: FeatureHost, handler: (arg: unknown) => Promise<void>, arg: unknown): Promise<void> {
  try {
    await handler(arg);
  } catch (err) {
    host.log('error', 'ghostex: drive command failed', { error: String(err) });
    void vscode.window.showErrorMessage(`Ghostex: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- command handlers ------------------------------------------------------

async function createTerminalSession(): Promise<void> {
  const { driver, client } = buildDriver();
  const projectId = await pickProjectId(client);
  if (!projectId) return;
  const title = await prompt({ prompt: 'Session title (optional)', placeHolder: 'e.g. build watcher' });
  const cwd = await prompt({ prompt: 'Working directory (optional)', value: defaultCwd() });
  const session = await driver.createTerminalSession({ projectId, title, cwd });
  void vscode.window.showInformationMessage(`Ghostex: created terminal session "${session.title}".`);
}

async function createAgentSession(): Promise<void> {
  const { driver, client } = buildDriver();
  const projectId = await pickProjectId(client);
  if (!projectId) return;
  const agentId = await prompt({ prompt: 'Agent id', value: 'claude', placeHolder: 'claude, codex, …' });
  if (!agentId) return;
  const title = await prompt({ prompt: 'Session title (optional)', placeHolder: 'names the session in Ghostex' });
  const cwd = await prompt({ prompt: 'Working directory (optional)', value: defaultCwd() });
  const session = await driver.createAgentSession({ projectId, agentId, title, cwd });
  const reveal = await vscode.window.showInformationMessage(
    `Ghostex: created agent session "${session.title}".`,
    'Reveal in Ghostex',
  );
  if (reveal) await driver.focus({ sessionId: session.sessionId, projectId: session.projectId });
}

async function renameSession(arg: unknown): Promise<void> {
  const { driver, client } = buildDriver();
  const target = await resolveTarget(client, arg);
  if (!target) return;
  const title = await prompt({ prompt: 'New session title', placeHolder: 'rename in Ghostex' });
  if (!title) return;
  await driver.rename(target, title);
  void vscode.window.showInformationMessage(`Ghostex: renamed session to "${title}".`);
}

async function runLifecycle(arg: unknown, op: 'focus' | 'sleep' | 'wake', verb: string): Promise<void> {
  const { driver, client } = buildDriver();
  const target = await resolveTarget(client, arg);
  if (!target) return;
  const session =
    op === 'focus' ? await driver.focus(target) : op === 'sleep' ? await driver.sleep(target) : await driver.wake(target);
  void vscode.window.showInformationMessage(`Ghostex: ${verb} "${session.title}".`);
}

async function killSession(arg: unknown): Promise<void> {
  const { driver, client } = buildDriver();
  const target = await resolveTarget(client, arg);
  if (!target) return;
  const confirm = await vscode.window.showWarningMessage(
    'Kill this Ghostex session?',
    { modal: true, detail: `Session ${target.sessionId} will be terminated.` },
    'Kill',
  );
  if (confirm !== 'Kill') return;
  const session = await driver.kill(target);
  void vscode.window.showInformationMessage(`Ghostex: killed "${session.title}".`);
}

async function sendToSession(arg: unknown, kind: 'text' | 'message'): Promise<void> {
  const { driver, client } = buildDriver();
  const target = await resolveTarget(client, arg);
  if (!target) return;
  const body = await prompt({
    prompt: kind === 'message' ? 'Message (sent and submitted)' : 'Text (staged, not submitted)',
    placeHolder: kind === 'message' ? 'e.g. run the tests' : 'typed into the session without Enter',
  });
  if (!body) return;
  if (kind === 'message') await driver.sendMessage(target, body);
  else await driver.sendText(target, body);
  void vscode.window.showInformationMessage(`Ghostex: sent ${kind} to the session.`);
}

async function readSessionText(arg: unknown): Promise<void> {
  const { driver, client } = buildDriver();
  const target = await resolveTarget(client, arg);
  if (!target) return;
  const text = await driver.readText(target);
  const doc = await vscode.workspace.openTextDocument({ content: text, language: 'log' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

// ---- input + client helpers ------------------------------------------------

/** Build a {@link SessionDriver} (and the underlying client) from current config. */
function buildDriver(): { driver: SessionDriver; client: GxClient } {
  const client = buildGxClient();
  return { driver: new SessionDriver(client), client };
}

/** Construct the client over the configured transport (CLI by default; D1). */
function buildGxClient(): GxClient {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if (config.get<string>('ghostex.commandTransport', 'cli') === 'rpc') {
    const baseUrl = config.get<string>('ghostex.gxserverUrl', '').trim() || DEFAULT_GXSERVER_BASE_URL;
    return GxClient.rpc({ baseUrl, token: resolveRpcToken(config) });
  }
  const gxPath = config.get<string>('ghostex.gxPath', '').trim() || 'gx';
  return GxClient.cli({ gxPath });
}

/** Resolve the RPC bearer token: explicit setting, else the documented token file. */
function resolveRpcToken(config: vscode.WorkspaceConfiguration): string | null {
  const fromSetting = config.get<string>('ghostex.gxserverToken', '').trim();
  return fromSetting || null;
}

/** First workspace folder's path, as a sensible default cwd for new sessions. */
function defaultCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** A trimmed input-box prompt; returns `undefined` when cancelled or left blank. */
async function prompt(options: vscode.InputBoxOptions): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({ ignoreFocusOut: true, ...options });
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve a session target from a context-menu node, else prompt via quickpick. */
async function resolveTarget(client: GxClient, arg: unknown): Promise<GhostexSessionTarget | undefined> {
  return resolveSessionTarget(arg) ?? (await pickSession(client));
}

interface SessionPick extends vscode.QuickPickItem {
  readonly target: GhostexSessionTarget;
}

/** Quickpick over the live sessions; returns the chosen target or `undefined`. */
async function pickSession(client: GxClient): Promise<GhostexSessionTarget | undefined> {
  const sessions = await client.listSessions();
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage('Ghostex: no sessions to choose from.');
    return undefined;
  }
  const items: SessionPick[] = sessions.map((s: GhostexSession) => ({
    label: s.title,
    description: `${s.kind} · ${s.lifecycleState}`,
    detail: s.sessionId,
    target: { sessionId: s.sessionId, projectId: s.projectId },
  }));
  const picked = await vscode.window.showQuickPick(items, { title: 'Select a Ghostex session', matchOnDetail: true });
  return picked?.target;
}

/** Quickpick over the projects; returns the chosen project id or `undefined`. */
async function pickProjectId(client: GxClient): Promise<string | undefined> {
  const projects = await client.listProjects();
  if (projects.length === 0) {
    void vscode.window.showWarningMessage('Ghostex: no projects available to create a session in.');
    return undefined;
  }
  const items = projects.map((p: GhostexProject) => ({ label: p.name, detail: p.projectId, projectId: p.projectId }));
  const picked = await vscode.window.showQuickPick(items, { title: 'Select a Ghostex project', matchOnDetail: true });
  return picked?.projectId;
}
