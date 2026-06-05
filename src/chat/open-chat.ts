// The `gascityCockpit.openChat` command implementation: resolve a client from
// the current connection, pick a city + session, and open a {@link ChatPanel}.
// Pure vscode glue (PRD: thin editor layer) — the testable bits (city/session
// ranking, the conversation store) live elsewhere. City selection lists the
// supervisor's cities in a QuickPick (PRD Story 2: multi-city switching), and
// falls back to a text box when the list can't be fetched.
import * as vscode from "vscode";
import * as path from "node:path";
import { createCockpitClient, listCities, listSessions, type CockpitClient } from "../api/index.ts";
import { DEFAULT_SUPERVISOR_BASE_URL, type ApiEndpoint, type Logger } from "../discovery/index.ts";
import { ChatPanel } from "./chat-panel.ts";
import { cityPickLabel, rankCitiesForPicker } from "./city-picker.ts";
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

  const cityName = args.preset?.cityName ?? (await pickCity(client, args.log));
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

/**
 * Pick a city to chat in. Lists the supervisor's cities (running first, the open
 * workspace's city floated to the top) in a QuickPick; falls back to a text box
 * when the supervisor can't be listed or knows of no cities, so an offline or
 * single-city operator is never blocked.
 */
async function pickCity(client: CockpitClient, log: Logger): Promise<string | undefined> {
  const result = await listCities(client);
  if (!result.ok) {
    log("warn", `chat: could not list cities: ${result.error.title}`);
    return promptCity("Couldn't list cities — enter a city name");
  }

  const cities = result.data.items ?? [];
  if (cities.length === 0) {
    return promptCity("No cities registered — enter a city name");
  }

  const ranked = rankCitiesForPicker(cities, workspaceCityName());
  const pick = await vscode.window.showQuickPick(ranked.map(cityPickLabel), {
    title: "GasCity Cockpit: Chat",
    placeHolder: "Select a city to chat in (running cities first)",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return pick?.name;
}

/** The open workspace folder's basename — a good default city guess. */
function workspaceCityName(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && folder.uri.scheme === "file" ? path.basename(folder.uri.fsPath) : "";
}

async function promptCity(prompt = "City name"): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: "GasCity Cockpit: Chat",
    prompt,
    value: workspaceCityName(),
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
