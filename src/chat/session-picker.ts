// Pure helpers for the "which session do I chat with?" picker. Kept vscode-free
// and unit-tested: the product rule that the Mayor is the default chat target
// (PRD Story 16) is logic, not glue, so it lives behind a testable seam. The
// vscode QuickPick wiring is in `open-chat.ts`.
import type { SessionDetail } from "../api/index.ts";

/** Heuristic: does this session look like a Mayor (the default chat target)? */
export function isLikelyMayor(session: SessionDetail): boolean {
  const haystack = [session.template, session.alias, session.display_name, session.title]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("mayor");
}

/**
 * Order sessions for the chat picker: Mayor(s) first, then active sessions, then
 * alphabetically by display name. Returns a new array; does not mutate input.
 */
export function rankSessionsForChat(sessions: SessionDetail[]): SessionDetail[] {
  return [...sessions].sort((a, b) => {
    const mayorRank = Number(!isLikelyMayor(a)) - Number(!isLikelyMayor(b));
    if (mayorRank !== 0) {
      return mayorRank;
    }
    const activeRank = Number(a.state !== "active") - Number(b.state !== "active");
    if (activeRank !== 0) {
      return activeRank;
    }
    return displayName(a).localeCompare(displayName(b));
  });
}

function displayName(session: SessionDetail): string {
  return session.display_name || session.title || session.session_name;
}

/** A QuickPick-ready label for a session (label/description/detail + the id). */
export interface SessionPickLabel {
  label: string;
  description: string;
  detail: string;
  id: string;
}

/** Build the picker label for one session. Pure. */
export function sessionPickLabel(session: SessionDetail): SessionPickLabel {
  const parts = [session.state];
  if (session.template) {
    parts.push(session.template);
  }
  return {
    label: displayName(session),
    description: parts.join(" · "),
    detail: session.id,
    id: session.id,
  };
}
