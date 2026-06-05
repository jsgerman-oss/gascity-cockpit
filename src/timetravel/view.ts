// Pure projection of recorded events into scrubber rows (Seam 1).
//
// Reuses the live Event Feed's presentation helpers (`eventLabel`,
// `eventDescription`, `eventStatusKind`) so the time-travel list reads exactly
// like the feed it replays — same headline, same description, same severity
// tint. `vscode`-free and unit-tested.
import { eventDescription, eventLabel, eventStatusKind } from '../status/index.ts';
import type { EventSeverity, FleetEvent, TimelineRow } from './types.ts';

/**
 * Project recorded events (chronological) into serializable webview rows. Keeps
 * the order it is given — the recorder already holds events oldest-first.
 */
export function buildTimelineView(events: readonly FleetEvent[]): TimelineRow[] {
  return events.map((e) => ({
    seq: e.seq,
    type: e.type,
    ts: e.ts,
    actor: e.actor,
    city: e.city,
    subject: e.subject ?? '',
    message: e.message ?? '',
    label: eventLabel(e),
    desc: eventDescription(e),
    // eventStatusKind only returns ok/warn/error for an event type (see types.ts).
    kind: eventStatusKind(e.type) as EventSeverity,
  }));
}
