// The `gascityCockpit.openChat` command implementation: resolve a client from
// the current connection, pick a city + session, and open a {@link ChatPanel}.
// Pure vscode glue (PRD: thin editor layer) — the testable bits (session
// ranking, the conversation store) live elsewhere. City selection here is a
// simple prompt; richer multi-city selection is a separate concern (PRD Story 2).
import * as vscode from "vscode";
import * as path from "node:path";
import { createCockpitClient, listSessions, type CockpitClient } from "../api/index.ts";
import { DEFAULT_SUPERVISOR_BASE_URL, type ApiEndpoint, type Logger } from "../discovery/index.ts";
import { ChatPanel } from "./chat-panel.ts";
import { ConversationStore } from "./conversation-store.ts";
import { rankSessionsForChat, sessionPickLabel } from "./session-picker.ts";

export interface OpenChatArgs {
  /** The currently-resolved endpoint, or null to fall back to the default URL. */
  endpoint: ApiEndpoint | null;
  log: Logger;
  /** Optional preset so other surfaces (e.g. a sessions tree) can open chat directly. */
  preset?: { cityName?: string; sessionId?: string };
}

/** Open a chat panel, prompting for city/session unless preset. */
export async function openChat(args: OpenChatArgs): Promise<void> {
  const baseUrl = args.endpoint?.baseUrl ?? DEFAULT_SUPERVISOR_BASE_URL;
  const token = args.endpoint?.token ?? null;
  const client = createCockpitClient({
    baseUrl,
    timeoutMs: 5000,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });

  const cityName = args.preset?.cityName ?? (await promptCity());
  if (!cityName) {
    return;
  }

  const sessionId = args.preset?.sessionId ?? (await pickSession(client, cityName, args.log));
  if (!sessionId) {
    return;
  }

  const store = new ConversationStore({ client, endpoint: { baseUrl, token }, cityName, sessionId });
  ChatPanel.create(store);
}

async function promptCity(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const prefill = folder && folder.uri.scheme === "file" ? path.basename(folder.uri.fsPath) : "";
  const value = await vscode.window.showInputBox({
    title: "GasCity Cockpit: Chat",
    prompt: "City name",
    value: prefill,
    ignoreFocusOut: true,
  });
  return value?.trim() || undefined;
}

async function pickSession(
  client: CockpitClient,
  cityName: string,
  log: Logger,
): Promise<string | undefined> {
  const result = await listSessions(client, { cityName, peek: false });
  if (!result.ok) {
    log("warn", `chat: could not list sessions for ${cityName}: ${result.error.title}`);
    return manualSessionId(cityName, `Couldn't list sessions — enter a session id in ${cityName}`);
  }

  const sessions = rankSessionsForChat(result.data.items ?? []);
  if (sessions.length === 0) {
    return manualSessionId(cityName, `No sessions found — enter a session id in ${cityName}`);
  }

  const pick = await vscode.window.showQuickPick(sessions.map(sessionPickLabel), {
    title: `Chat — ${cityName}`,
    placeHolder: "Select a session to chat with (the Mayor is listed first)",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return pick?.id;
}

async function manualSessionId(cityName: string, prompt: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: `GasCity Cockpit: Chat — ${cityName}`,
    prompt,
    ignoreFocusOut: true,
  });
  return value?.trim() || undefined;
}
