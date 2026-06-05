// Presentation helpers for notification toasts.
//
// Pure mappings from a {@link CockpitNotification} to the strings/actions the
// editor glue feeds to `vscode.window.show*Message`. Kept out of the glue so the
// wording and the allow/deny action mapping are unit-tested.
import {
  PENDING_KIND_TOOL_APPROVAL,
  RESPOND_ACTION_ALLOW,
  RESPOND_ACTION_DENY,
} from '../api/index.ts';
import { approvalKey, type PendingApproval } from './pending.ts';
import type { CockpitNotification } from './types.ts';

/** A button on an approval toast: the label shown and the respond action it sends. */
export interface ApprovalAction {
  readonly label: string;
  readonly action: string;
}

/**
 * Render a pending approval as a warning notification carrying the respond
 * context (`city`/`sessionId`/`requestId`/`kind`). The single source of truth
 * for the wording, used both by the engine's diff and the on-demand picker.
 */
export function approvalNotification(a: PendingApproval): CockpitNotification {
  const isTool = a.kind === PENDING_KIND_TOOL_APPROVAL;
  return {
    id: approvalKey(a),
    category: 'approval',
    severity: 'warning',
    title: isTool ? 'Tool approval needed' : 'Agent waiting for input',
    detail: `${a.sessionId} · ${a.city}`,
    city: a.city,
    sessionId: a.sessionId,
    requestId: a.requestId,
    kind: a.kind,
  };
}

/** The single-line message shown in the toast. */
export function notificationMessage(n: CockpitNotification): string {
  return n.detail ? `${n.title} — ${n.detail}` : n.title;
}

/**
 * Inline actions for an approval notification. A tool-approval offers Allow/Deny
 * mapped to the conventional respond tokens; a prompt-for-input is notify-only —
 * its submit token is provider-specific and not carried by the city-level
 * aggregation, so we never guess an answer. Non-approval notifications have no
 * inline actions.
 */
export function approvalActions(n: CockpitNotification): ApprovalAction[] {
  if (n.category !== 'approval') return [];
  if (n.kind === PENDING_KIND_TOOL_APPROVAL) {
    return [
      { label: 'Allow', action: RESPOND_ACTION_ALLOW },
      { label: 'Deny', action: RESPOND_ACTION_DENY },
    ];
  }
  return [];
}
