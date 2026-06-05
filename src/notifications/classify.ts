// Pure classification of supervisor fleet events into notifications.
//
// The SSE feed (`/v0/events/stream`) carries the whole fleet lifecycle; only a
// slice of it is worth interrupting an operator for. This module is the policy:
// which event types become a toast, in which category, with what wording. It is
// pure and `vscode`-free so the policy is exhaustively unit-testable.
import type { FleetEvent } from '../status/index.ts';
import type { CockpitNotification } from './types.ts';

/** The mail event that means "a message just landed in an inbox". */
const MAIL_ARRIVED_TYPE = 'mail.sent';

/**
 * Fleet event types that signal an agent needs a human — something failed, got
 * stuck, or was torn down while holding work. These are escalations in the
 * operational sense: each one is a worker that would otherwise wait unseen.
 * Routine lifecycle (woke / draining / idle_killed / max_age_killed / stopped /
 * created / updated) is deliberately excluded — it is not an escalation.
 */
const ESCALATION_LABELS: Readonly<Record<string, string>> = {
  'session.crashed': 'Session crashed',
  'session.stranded': 'Session stranded',
  'session.quarantined': 'Session quarantined',
  'session.cold_start_timeout': 'Session failed to start',
  'session.work_query_failed': 'Work lookup failed',
  'session.reset_stalled': 'Stalled session reset',
  'session.drain_acked_with_assigned_work': 'Drained while holding work',
  'session.undrained': 'Session failed to drain',
  'order.failed': 'Order failed',
  'request.failed': 'Request failed',
};

/** Whether an event type is one we treat as an escalation. */
export function isEscalationType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(ESCALATION_LABELS, type);
}

/** All escalation event types (handy for tests and the docs). */
export function escalationTypes(): string[] {
  return Object.keys(ESCALATION_LABELS);
}

/**
 * Map one fleet event to a notification, or `null` when it is not worth
 * surfacing. Mail and escalations are the two event-backed categories; approvals
 * come from the pending-interactions endpoint, not the event feed, so they are
 * not produced here.
 */
export function classifyEvent(event: FleetEvent): CockpitNotification | null {
  if (event.type === MAIL_ARRIVED_TYPE) {
    return {
      id: `mail:${event.seq}`,
      category: 'mail',
      severity: 'info',
      title: 'New mail',
      ...detailField(mailDetail(event)),
      ...cityField(event.city),
    };
  }

  if (isEscalationType(event.type)) {
    return {
      id: `esc:${event.seq}`,
      category: 'escalation',
      severity: 'warning',
      title: ESCALATION_LABELS[event.type],
      ...detailField(escalationDetail(event)),
      ...cityField(event.city),
    };
  }

  return null;
}

/** "from <actor>: <message>" for a mail event, dropping any missing piece. */
function mailDetail(event: FleetEvent): string {
  const from = event.actor ? `from ${event.actor}` : '';
  return joinParts([from, event.message], ': ');
}

/** "<actor> · <message>" for an escalation, falling back to the subject. */
function escalationDetail(event: FleetEvent): string {
  const body = event.message || event.subject || '';
  return joinParts([event.actor, body], ' · ');
}

/** Join non-empty parts with `sep`; "" when nothing is present. */
function joinParts(parts: Array<string | undefined>, sep: string): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(sep);
}

/** Spread helper so an empty detail is omitted rather than set to "". */
function detailField(detail: string): { detail?: string } {
  return detail ? { detail } : {};
}

/** Spread helper so an empty city is omitted (supervisor-global events). */
function cityField(city: string): { city?: string } {
  return city ? { city } : {};
}
