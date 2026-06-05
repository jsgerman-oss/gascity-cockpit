// Domain model for event time-travel — scrub + replay of the supervisor event
// feed (cockpit-21l.6).
//
// A `vscode`-free layer (PRD Seam 1): the recorder buffers the `/v0/events/stream`
// feed into a replayable timeline, and `view.ts` projects it into the rows the
// scrubber webview renders. Nothing here imports `vscode`; the editor glue lives
// in `../views/timeTravel.ts`.
import type { FleetEvent, StatusKind } from '../status/index.ts';

export type { FleetEvent };

/**
 * Coarse severity carried per row so the scrubber can tint failures/warnings,
 * consistent with the live Event Feed. The full {@link StatusKind} enum also has
 * busy/idle/off, but `eventStatusKind` only ever yields these three for an event
 * type, so the projection narrows to them.
 */
export type EventSeverity = Extract<StatusKind, 'ok' | 'warn' | 'error'>;

/** Time/sequence span of a recording, or null when nothing has been recorded. */
export interface TimelineBounds {
  /** Number of events retained in the recording. */
  count: number;
  /** Sequence number of the oldest / newest recorded event. */
  firstSeq: number;
  lastSeq: number;
  /** RFC3339 timestamp of the oldest / newest event ('' when the event had none). */
  firstTs: string;
  lastTs: string;
}

/**
 * One event projected for the scrubber webview: the raw fields plus the
 * presentation the live Event Feed already uses (`eventLabel` / `eventDescription`
 * / `eventStatusKind`), precomputed host-side so the webview renders strings only
 * (never markup) — keeping the document XSS-safe and the client script trivial.
 */
export interface TimelineRow {
  seq: number;
  type: string;
  ts: string;
  actor: string;
  city: string;
  /** Optional fields are normalised to '' so the row is a plain string record. */
  subject: string;
  message: string;
  /** `eventLabel(event)` — the headline (the event type). */
  label: string;
  /** `eventDescription(event)` — city · actor · message/subject. */
  desc: string;
  /** `eventStatusKind(type)` — ok / warn / error, for tinting. */
  kind: EventSeverity;
}

/** A point-in-time copy of the recording handed to a freshly opened panel. */
export interface TimelineSnapshot {
  rows: TimelineRow[];
  bounds: TimelineBounds | null;
}
