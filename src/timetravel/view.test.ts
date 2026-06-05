import { describe, expect, it } from 'vitest';
import { buildTimelineView } from './view';
import type { FleetEvent } from '../status/index.ts';

const event = (over: Partial<FleetEvent> = {}): FleetEvent => ({
  seq: 1,
  type: 'session.updated',
  ts: '2026-06-05T00:00:01Z',
  actor: 'furiosa',
  city: 'blackrim-hq',
  ...over,
});

describe('buildTimelineView', () => {
  it('preserves order and projects the raw fields', () => {
    const rows = buildTimelineView([event({ seq: 1 }), event({ seq: 2 }), event({ seq: 3 })]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({
      type: 'session.updated',
      ts: '2026-06-05T00:00:01Z',
      actor: 'furiosa',
      city: 'blackrim-hq',
    });
  });

  it('reuses the live feed presentation (label + description)', () => {
    const [row] = buildTimelineView([event({ type: 'bead.closed', message: 'merged at abc' })]);
    expect(row.label).toBe('bead.closed');
    // eventDescription joins city · actor · message.
    expect(row.desc).toBe('blackrim-hq · furiosa · merged at abc');
  });

  it('normalises optional subject/message to empty strings', () => {
    const [row] = buildTimelineView([event({})]);
    expect(row.subject).toBe('');
    expect(row.message).toBe('');
  });

  it('tints severity from the event type', () => {
    const rows = buildTimelineView([
      event({ seq: 1, type: 'session.updated' }),
      event({ seq: 2, type: 'agent.drained' }),
      event({ seq: 3, type: 'session.crashed' }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['ok', 'warn', 'error']);
  });
});
