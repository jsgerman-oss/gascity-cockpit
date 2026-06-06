/**
 * The native `@mayor` chat participant (cockpit-dc8.2): the Mayor, living in VS
 * Code's own chat window where Copilot put its chat UI. Users type `@mayor …` and
 * the request handler bridges the prompt to the active city's Mayor session over
 * the `/v0` API, streaming the reply back as markdown + progress.
 *
 * This file is the thin editor glue (PRD: the vscode-bound layer is small). The
 * turn lifecycle — submit, stream projection, completion, pending detection —
 * lives in the vscode-free {@link driveTurn} core and is unit-tested there. Here
 * we only resolve the target city/session, map a {@link ChatResponseStream} onto a
 * {@link ParticipantSink}, and render the {@link TurnOutcome}.
 *
 * ## Markdown-only limitations vs the rich webview chat
 *
 * The native chat UI renders markdown; it can't host the Cockpit's approval
 * webview, permission-mode toggle, or interrupt/follow-up affordances. So:
 *
 *  - **Tool approvals & prompt-for-input** can't be answered inline. When the
 *    Mayor needs one, the turn stops, describes the prompt as markdown, and offers
 *    a button that deep-links into the full {@link ChatPanel} (`openChat`) where
 *    the operator approves.
 *  - **No permission-mode / interrupt controls.** Those stay in the webview chat.
 *  - **One Mayor per turn.** `/city` switches the target city; the Mayor is the
 *    default session (first by {@link rankSessionsForChat}).
 *
 * For the full experience, the status-bar "Mayor" button and `openChat` open the
 * webview chat; this participant is the lightweight, always-at-hand surface.
 */
import * as vscode from 'vscode';
import {
  bearerAuthHeader,
  createCockpitClient,
  listCities,
  listSessions,
  type CockpitClient,
} from '../api/index.ts';
import { DEFAULT_SUPERVISOR_BASE_URL } from '../discovery/index.ts';
import { CONFIG_SECTION, type CockpitFeature, type FeatureHost } from '../host/index.ts';
import { ConversationStore } from '../chat/conversation-store.ts';
import { rankCitiesForPicker } from '../chat/city-picker.ts';
import { rankSessionsForChat } from '../chat/session-picker.ts';
import { describePending, driveTurn, type ParticipantSink } from '../chat/participant-bridge.ts';

/** Must match the `id` in `chatParticipant.contributes.json`'s `chatParticipants`. */
const PARTICIPANT_ID = `${CONFIG_SECTION}.mayor`;
/** The `@mayor /city` slash command name. */
const CITY_COMMAND = 'city';

const chatParticipantFeature: CockpitFeature = {
  id: 'chatParticipant',
  activate(host: FeatureHost): void {
    // The chat API only exists on VS Code >= 1.90. Guard so the extension still
    // activates cleanly on older editors (the rest of the Cockpit is unaffected).
    if (typeof vscode.chat?.createChatParticipant !== 'function') {
      host.log('info', 'chat participant: vscode.chat API unavailable; @mayor not registered');
      return;
    }

    // The sticky target city, switched with `@mayor /city`. Defaults to the
    // workspace's own city, then the first running city.
    let activeCity: string | undefined;

    const handler: vscode.ChatRequestHandler = async (request, _context, response, token) => {
      const endpoint = host.getEndpoint();
      const baseUrl = endpoint?.baseUrl ?? DEFAULT_SUPERVISOR_BASE_URL;
      const apiToken = endpoint?.token ?? null;
      const client = createCockpitClient({
        baseUrl,
        timeoutMs: 5000,
        headers: bearerAuthHeader(apiToken),
      });

      // `/city` — switch the target city for subsequent turns.
      if (request.command === CITY_COMMAND) {
        const picked = await resolveCityCommand(client, request.prompt);
        if (picked) {
          activeCity = picked;
          response.markdown(
            `Target city set to **${picked}**. Ask me anything — or \`@mayor /city\` to switch again.`,
          );
        } else {
          response.markdown('No city selected. Try `@mayor /city <name>`.');
        }
        return { metadata: { command: CITY_COMMAND, city: picked ?? '' } };
      }

      // An empty prompt would be rejected by the submit API; answer with a hint.
      if (!request.prompt.trim()) {
        response.markdown('Ask me something, e.g. *"what\'s the fleet status?"* — or `@mayor /city` to switch city.');
        return {};
      }

      const cityName = activeCity ?? workspaceCityName() ?? (await firstRunningCity(client, host));
      if (!cityName) {
        response.markdown(
          'I could not find a city to talk to. Use `@mayor /city` to pick one, or start a city first.',
        );
        return {};
      }

      const sessionId = await resolveMayorSession(client, cityName, host);
      if (!sessionId) {
        response.markdown(`No Mayor session found in **${cityName}**.`);
        response.button({
          title: 'Open the Cockpit chat picker',
          command: `${CONFIG_SECTION}.openChat`,
          arguments: [{ cityName }],
        });
        return { metadata: { city: cityName } };
      }

      const store = new ConversationStore({
        client,
        endpoint: { baseUrl, token: apiToken },
        cityName,
        sessionId,
        // The bridge owns the city-event correlation that completes the turn, so
        // the store's own correlation would be a redundant second event stream.
        awaitSubmitOutcome: null,
      });

      const sink: ParticipantSink = {
        markdown: (text) => response.markdown(text),
        progress: (text) => response.progress(text),
      };

      // VS Code hands us a CancellationToken; bridge it to the AbortSignal the
      // vscode-free core understands.
      const abort = new AbortController();
      const cancelSub = token.onCancellationRequested(() => abort.abort());
      if (token.isCancellationRequested) {
        abort.abort();
      }

      try {
        const outcome = await driveTurn({
          store,
          endpoint: { baseUrl, token: apiToken },
          prompt: request.prompt,
          signal: abort.signal,
          sink,
        });

        switch (outcome.status) {
          case 'pending':
            response.markdown(`\n\n${describePending(outcome.pending)}`);
            response.button({
              title: 'Respond in the Mayor chat',
              command: `${CONFIG_SECTION}.openChat`,
              arguments: [{ cityName, sessionId }],
            });
            return { metadata: { city: cityName, sessionId, status: 'pending' } };
          case 'error':
            response.markdown(`\n\n⚠️ ${outcome.message}`);
            return {
              errorDetails: { message: outcome.message },
              metadata: { city: cityName, sessionId, status: 'error' },
            };
          case 'cancelled':
            return { metadata: { city: cityName, sessionId, status: 'cancelled' } };
          case 'completed':
          default:
            return { metadata: { city: cityName, sessionId, status: 'completed' } };
        }
      } finally {
        cancelSub.dispose();
        store.dispose();
      }
    };

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = vscode.Uri.joinPath(host.context.extensionUri, 'media', 'cockpit.svg');
    participant.followupProvider = {
      provideFollowups(result) {
        const meta = result.metadata as { status?: string } | undefined;
        // After a hand-off to the rich panel, don't pile on more prompts.
        if (meta?.status === 'pending') {
          return [];
        }
        return [
          { prompt: "What's the fleet status?", label: 'Fleet status' },
          { prompt: 'Anything blocked or needing my attention?', label: 'Blockers' },
        ];
      },
    };

    host.context.subscriptions.push(participant);
  },
};

/** The open workspace folder's basename — the best default city guess. */
function workspaceCityName(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder && folder.uri.scheme === 'file') {
    const base = folder.uri.path.split('/').filter(Boolean).pop();
    return base || undefined;
  }
  return undefined;
}

/** First running city (else first known), for when no city is otherwise resolved. */
async function firstRunningCity(client: CockpitClient, host: FeatureHost): Promise<string | undefined> {
  const result = await listCities(client);
  if (!result.ok) {
    host.log('warn', `chat participant: could not list cities: ${result.error.title}`);
    return undefined;
  }
  const ranked = rankCitiesForPicker(result.data.items ?? []);
  return ranked[0]?.name;
}

/** Resolve the `/city` argument: an explicit name, else an interactive QuickPick. */
async function resolveCityCommand(client: CockpitClient, prompt: string): Promise<string | undefined> {
  const explicit = prompt.trim();
  if (explicit) {
    return explicit;
  }
  const result = await listCities(client);
  if (!result.ok || (result.data.items ?? []).length === 0) {
    return (
      await vscode.window.showInputBox({
        title: 'GasCity Cockpit: Chat with the Mayor',
        prompt: 'Enter a city name',
        ignoreFocusOut: true,
      })
    )?.trim() || undefined;
  }
  const ranked = rankCitiesForPicker(result.data.items ?? [], workspaceCityName());
  const pick = await vscode.window.showQuickPick(
    ranked.map((city) => ({ label: city.name, description: city.running ? 'running' : 'stopped' })),
    { title: 'Chat with the Mayor — pick a city', placeHolder: 'Running cities first' },
  );
  return pick?.label;
}

/** The Mayor session id in a city — the default chat target (Mayor ranked first). */
async function resolveMayorSession(
  client: CockpitClient,
  cityName: string,
  host: FeatureHost,
): Promise<string | undefined> {
  const result = await listSessions(client, { cityName, peek: false });
  if (!result.ok) {
    host.log('warn', `chat participant: could not list sessions for ${cityName}: ${result.error.title}`);
    return undefined;
  }
  const ranked = rankSessionsForChat(result.data.items ?? []);
  return ranked[0]?.id;
}

export default chatParticipantFeature;
