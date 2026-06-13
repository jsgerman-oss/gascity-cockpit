// Pure helpers for the "which Ghostex agent session do I chat with?" picker —
// the Ghostex-side mirror of `session-picker.ts`. Kept vscode-free and unit-tested:
// the product rule (only agent sessions are chat targets, freshest first) is logic,
// not glue. The QuickPick wiring lives in `open-ghostex-chat.ts`.
import type { GhostexSession } from "../ghostex/index.ts";

/** Only agent-kind sessions host an interactive agent to chat with. */
export function isAgentSession(session: GhostexSession): boolean {
  return session.kind === "agent";
}

/**
 * Order Ghostex agent sessions for the chat picker: agent sessions only, running
 * sessions first, then the most recently active, then by title. Returns a new
 * array; does not mutate the input.
 */
export function rankGhostexAgentSessions(sessions: readonly GhostexSession[]): GhostexSession[] {
  return sessions.filter(isAgentSession).sort((a, b) => {
    const runningRank = Number(a.lifecycleState !== "running") - Number(b.lifecycleState !== "running");
    if (runningRank !== 0) {
      return runningRank;
    }
    const recencyRank = lastActive(b) - lastActive(a);
    if (recencyRank !== 0) {
      return recencyRank;
    }
    return title(a).localeCompare(title(b));
  });
}

/** Epoch ms of a session's last activity (falls back to `updatedAt`; 0 when unparseable). */
function lastActive(session: GhostexSession): number {
  const stamp = session.lastActiveAt ?? session.updatedAt;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? 0 : ms;
}

function title(session: GhostexSession): string {
  return session.title || session.sessionId;
}

/** A QuickPick-ready label for a Ghostex agent session (label/description/detail + id). */
export interface GhostexSessionPickLabel {
  label: string;
  description: string;
  detail: string;
  id: string;
}

/** Build the picker label for one Ghostex agent session. Pure. */
export function ghostexSessionPickLabel(session: GhostexSession): GhostexSessionPickLabel {
  const parts: string[] = [session.lifecycleState];
  if (session.agentId) {
    parts.push(session.agentId);
  }
  return {
    label: title(session),
    description: parts.join(" · "),
    detail: session.sessionId,
    id: session.sessionId,
  };
}
