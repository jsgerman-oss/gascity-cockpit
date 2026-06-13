// The `gascityCockpit.ghostex.chat` command: discover gxserver, pick a Ghostex
// agent session, and open a {@link ChatPanel} bound to a {@link GhostexConversationStore}.
// Pure vscode glue (PRD: thin editor layer, excluded from coverage) — the testable
// bits (the conversation store, the agent-session ranking) live behind vscode-free
// seams. This is the Ghostex-side mirror of `open-chat.ts`.
//
// The store streams the agent's output by re-reading `readSessionText` whenever a
// gxserver presentation event touches the session. That event source is the
// `/api/events` WebSocket when the editor host has a global `WebSocket` (Node ≥21),
// and otherwise a `readPresentationSnapshot` poll on the configured cadence — both
// emit the same `GhostexEvent`s the store consumes, so no `ws` dependency is needed.
import * as vscode from "vscode";
import {
  GxClient,
  GhostexEventStream,
  discoverGhostex,
  type GhostexDiscoveryInputs,
  type GhostexEndpoint,
  type WebSocketLike,
} from "../ghostex/index.ts";
import type { Logger } from "../discovery/index.ts";
import { GhostexConversationStore, type GhostexEventSubscribe } from "./ghostex-conversation-store.ts";
import { ghostexSessionPickLabel, rankGhostexAgentSessions } from "./ghostex-session-picker.ts";
import { ChatPanel } from "./chat-panel.ts";

export interface OpenGhostexChatArgs {
  log: Logger;
  /** Resolve gxserver discovery inputs from settings (supplied by the Ghostex view glue). */
  discoveryInputs: () => GhostexDiscoveryInputs;
  /** Snapshot-poll cadence (ms) for the no-WebSocket fallback. Default 10s. */
  pollMs?: number;
  /** Preselected session (e.g. opened from the sessions tree); skips the picker. */
  preset?: { sessionId: string; title?: string; provider?: string };
}

/** Open a Ghostex agent-session chat panel, prompting for the session unless preset. */
export async function openGhostexChat(args: OpenGhostexChatArgs): Promise<void> {
  const discovery = await discoverGhostex(args.discoveryInputs());
  if (discovery.state !== "connected") {
    void vscode.window.showWarningMessage(`Ghostex: ${discovery.detail}`);
    return;
  }
  const { endpoint } = discovery;
  const gx = GxClient.rpc({ baseUrl: endpoint.baseUrl, token: endpoint.token });

  let sessionId = args.preset?.sessionId;
  let title = args.preset?.title;
  let provider = args.preset?.provider;

  if (!sessionId) {
    let sessions;
    try {
      sessions = await gx.listSessions();
    } catch (err) {
      void vscode.window.showWarningMessage(`Ghostex: couldn't list sessions — ${(err as Error).message}`);
      return;
    }
    const agents = rankGhostexAgentSessions(sessions);
    if (agents.length === 0) {
      void vscode.window.showInformationMessage("Ghostex: no agent sessions to chat with.");
      return;
    }
    const pick = await vscode.window.showQuickPick(agents.map(ghostexSessionPickLabel), {
      title: "Ghostex: Chat with Agent Session",
      placeHolder: "Select a Ghostex agent session (running first)",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick) {
      return;
    }
    sessionId = pick.id;
    title = pick.label;
    provider = agents.find((s) => s.sessionId === pick.id)?.agentId;
  }

  const subscribe = makeGhostexEventSubscribe(endpoint, args.pollMs ?? 10_000, gx, args.log);
  const store = new GhostexConversationStore({
    gx,
    sessionId,
    ...(title !== undefined ? { title } : {}),
    ...(provider !== undefined ? { provider } : {}),
    subscribe,
  });
  ChatPanel.create(store);
}

/**
 * Build the live event source for a connected gxserver endpoint: the `/api/events`
 * WebSocket when the host exposes a global `WebSocket`, else a snapshot poll.
 */
function makeGhostexEventSubscribe(
  endpoint: GhostexEndpoint,
  pollMs: number,
  gx: GxClient,
  log: Logger,
): GhostexEventSubscribe {
  const WebSocketCtor = (globalThis as Record<string, unknown>)["WebSocket"] as
    | (new (url: string) => WebSocketLike)
    | undefined;

  if (typeof WebSocketCtor === "function") {
    return (onEvent) => {
      const stream = new GhostexEventStream({
        baseUrl: endpoint.baseUrl,
        token: endpoint.token,
        createWebSocket: (url) => new WebSocketCtor(url),
        onEvent,
        log,
      });
      stream.start();
      return { dispose: () => stream.stop() };
    };
  }

  // No global WebSocket (Node < 21 in the editor host): poll the presentation
  // snapshot, surfacing it as the same `presentationSnapshot` event the WS sends.
  return (onEvent) => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      try {
        const snapshot = await gx.readPresentationSnapshot();
        if (!stopped) {
          onEvent({ type: "presentationSnapshot", revision: snapshot.revision, snapshot });
        }
      } catch (err) {
        log("debug", "ghostex chat: snapshot poll failed", { error: String(err) });
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), pollMs);
      }
    };
    void tick();
    return {
      dispose: () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
        }
      },
    };
  };
}
