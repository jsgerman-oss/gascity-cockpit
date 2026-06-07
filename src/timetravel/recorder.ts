// EventTimeline — the replayable recording behind event time-travel.
//
// A plain, `vscode`-free buffer (Seam 1). The feature feeds it the supervisor
// event stream; the scrubber panel reads a chronological snapshot and follows
// `onDidRecord` for live appends. Unlike the live Event Feed's newest-first ring
// (FleetStatusStore, cap 250), this keeps events in *chronological* order with a
// larger cap so an operator can scrub and replay a run for debugging and audit.
import { Emitter } from '../discovery/index.ts';
import type { FleetEvent } from '../status/index.ts';
import { buildTimelineView } from './view.ts';
import type { TimelineBounds, TimelineSnapshot } from './types.ts';

/** Maximum events retained in a recording; the oldest drop off past this. */
export const TIMELINE_CAP = 1000;

export class EventTimeline {
  /** Recorded events in chronological (ascending seq) order. */
  private buffer: FleetEvent[] = [];
  /** Highest seq seen, used to drop events re-delivered across a reconnect. */
  private maxSeq: number | null = null;
  private readonly recorded = new Emitter<FleetEvent>();

  /** Cap is configurable so tests can exercise the ring without 1000 events. */
  constructor(private readonly cap: number = TIMELINE_CAP) {}

  /** Fires once per newly-recorded event, after it is appended. */
  readonly onDidRecord = this.recorded.event;

  /** Number of events currently retained. */
  get size(): number {
    return this.buffer.length;
  }

  /** The retention cap in force, so a capture can record it and replay faithfully. */
  get capacity(): number {
    return this.cap;
  }

  /**
   * A shallow copy of the recorded events in chronological order. Unlike
   * {@link snapshot}, which projects to webview rows, this is the raw event
   * sequence — what a replay scenario serializes so a runner can re-derive the
   * snapshot and assert no drift. Returns a copy so callers can't mutate the ring.
   */
  events(): FleetEvent[] {
    return this.buffer.slice();
  }

  /**
   * Record one event. The supervisor seq is monotonic, so any event whose seq is
   * not greater than the highest seen is a duplicate (reconnect replay of the
   * `Last-Event-ID` cursor boundary) and is dropped. The buffer is bounded: once
   * full, the oldest event falls off so memory stays flat on a long-running rig.
   */
  record(event: FleetEvent): void {
    if (this.maxSeq !== null && event.seq <= this.maxSeq) return;
    this.maxSeq = event.seq;
    this.buffer.push(event);
    if (this.buffer.length > this.cap) this.buffer.shift();
    this.recorded.fire(event);
  }

  /**
   * Drop the whole recording. Called on a detected supervisor restart, where the
   * seq counter resets — mixing the two epochs would corrupt ordering/de-dup.
   */
  clear(): void {
    this.buffer = [];
    this.maxSeq = null;
  }

  /** Time/sequence span of the recording, or null when empty. */
  bounds(): TimelineBounds | null {
    if (this.buffer.length === 0) return null;
    const first = this.buffer[0];
    const last = this.buffer[this.buffer.length - 1];
    return {
      count: this.buffer.length,
      firstSeq: first.seq,
      lastSeq: last.seq,
      firstTs: first.ts,
      lastTs: last.ts,
    };
  }

  /** A point-in-time copy (projected rows + bounds) for a freshly opened panel. */
  snapshot(): TimelineSnapshot {
    return { rows: buildTimelineView(this.buffer), bounds: this.bounds() };
  }

  dispose(): void {
    this.recorded.dispose();
  }
}
