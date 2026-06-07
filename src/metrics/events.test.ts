import { describe, expect, it } from 'vitest';
import {
  UNATTRIBUTED,
  UNSCOPED_RIG,
  attribute,
  beadIdPrefix,
  buildRigIndex,
  isWorkBead,
  normalizeEvent,
  parseTsMs,
  resolveAgent,
  resolveRig,
  rigOfAgent,
} from './events.ts';
import type { RigIndex } from './types.ts';

const RIGS = [
  { name: 'gascity-cockpit', prefix: 'cockpit' },
  { name: 'nimbus', prefix: 'nim' },
  { name: 'gridwars', prefix: 'gridwars_run' },
  { name: 'whiskeyshop', prefix: null }, // unmappable from bead id
];

const index = (): RigIndex => buildRigIndex(RIGS);

/** A minimal bead payload record. */
function bead(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'cockpit-3x7', issue_type: 'feature', created_at: '2026-06-06T00:00:00Z', ...over };
}

/** A raw tagged envelope. */
function envelope(type: string, over: Record<string, unknown> = {}, beadOver: Record<string, unknown> = {}) {
  return {
    type,
    ts: '2026-06-06T02:00:00Z',
    actor: 'gascity-cockpit/gastown.refinery',
    city: 'blackrim-hq',
    payload: { bead: bead(beadOver) },
    ...over,
  };
}

describe('parseTsMs', () => {
  it('parses RFC3339 with Z and with an offset to the same instant', () => {
    expect(parseTsMs('2026-06-07T02:26:47Z')).toBe(parseTsMs('2026-06-06T19:26:47-07:00'));
  });
  it('returns null for empty, non-string, or unparseable input', () => {
    expect(parseTsMs('')).toBeNull();
    expect(parseTsMs('   ')).toBeNull();
    expect(parseTsMs(undefined)).toBeNull();
    expect(parseTsMs(12345)).toBeNull();
    expect(parseTsMs('not-a-date')).toBeNull();
  });
});

describe('beadIdPrefix', () => {
  it('takes the segment before the first dash', () => {
    expect(beadIdPrefix('cockpit-3x7')).toBe('cockpit');
    expect(beadIdPrefix('gridwars_run-abc')).toBe('gridwars_run');
    expect(beadIdPrefix('bh-wisp-x')).toBe('bh');
  });
  it('returns the whole id when there is no dash', () => {
    expect(beadIdPrefix('solo')).toBe('solo');
  });
});

describe('buildRigIndex', () => {
  it('maps prefixes to rig names and skips rigs without a prefix', () => {
    const idx = index();
    expect(idx.byPrefix.get('cockpit')).toBe('gascity-cockpit');
    expect(idx.byPrefix.get('nim')).toBe('nimbus');
    expect(idx.byPrefix.get('gridwars_run')).toBe('gridwars');
    expect(idx.byPrefix.has('whiskeyshop')).toBe(false);
  });
  it('tolerates non-array and non-record entries', () => {
    expect(buildRigIndex(null).byPrefix.size).toBe(0);
    expect(buildRigIndex('nope').byPrefix.size).toBe(0);
    expect(buildRigIndex([null, 7, { name: 'x' }, { prefix: 'y' }]).byPrefix.size).toBe(0);
  });
});

describe('resolveRig', () => {
  it('resolves a known prefix and falls back to unscoped', () => {
    expect(resolveRig('cockpit-3x7', index())).toBe('gascity-cockpit');
    expect(resolveRig('mystery-1', index())).toBe(UNSCOPED_RIG);
  });
});

describe('rigOfAgent', () => {
  it('extracts the rig portion of a scoped identity', () => {
    expect(rigOfAgent('gascity-cockpit/gastown.slit')).toBe('gascity-cockpit');
  });
  it('returns empty for unscoped identities', () => {
    expect(rigOfAgent('gastown.mayor')).toBe('');
    expect(rigOfAgent('/leading-slash')).toBe('');
  });
});

describe('isWorkBead', () => {
  it('accepts real work beads', () => {
    expect(isWorkBead('cockpit-3x7', 'feature')).toBe(true);
    expect(isWorkBead('cockpit-9aa', 'task')).toBe(true);
    expect(isWorkBead('cockpit-9aa', undefined)).toBe(true);
  });
  it('rejects ephemeral wisps and container types', () => {
    expect(isWorkBead('cockpit-wisp-o5meg', 'task')).toBe(false);
    expect(isWorkBead('bh-wisp-b2p4o2', 'task')).toBe(false);
    expect(isWorkBead('nim-cwc', 'epic')).toBe(false);
    expect(isWorkBead('nim-5vg', 'convoy')).toBe(false);
  });
});

describe('resolveAgent', () => {
  it('prefers the recorded implementing session', () => {
    expect(resolveAgent(bead({ metadata: { 'gc.session_name': 'gastown__polecat-x' }, assignee: 'a' }), 'actor')).toBe(
      'gastown__polecat-x',
    );
  });
  it('falls back to assignee, then actor, then unattributed', () => {
    expect(resolveAgent(bead({ assignee: 'gascity-cockpit/gastown.slit' }), 'actor')).toBe('gascity-cockpit/gastown.slit');
    expect(resolveAgent(bead(), 'controller')).toBe('controller');
    expect(resolveAgent(bead(), undefined)).toBe(UNATTRIBUTED);
    expect(resolveAgent(bead({ metadata: { other: 'x' } }), undefined)).toBe(UNATTRIBUTED);
  });
});

describe('attribute', () => {
  it('takes rig from the bead prefix and agent from the actor at close', () => {
    const a = attribute(bead({ id: 'cockpit-3x7', assignee: null }), 'gascity-cockpit/gastown.refinery', index());
    expect(a).toEqual({ rig: 'gascity-cockpit', agent: 'gascity-cockpit/gastown.refinery' });
  });
  it('falls back to the actor scope when the bead prefix is unknown', () => {
    const a = attribute(bead({ id: 'mystery-1' }), 'whiskeyshop/gastown.witness', index());
    expect(a).toEqual({ rig: 'whiskeyshop', agent: 'whiskeyshop/gastown.witness' });
  });
  it('stays unscoped when neither prefix nor actor is scoped', () => {
    const a = attribute(bead({ id: 'mystery-1' }), 'controller', index());
    expect(a).toEqual({ rig: UNSCOPED_RIG, agent: 'controller' });
  });
  it('tolerates a bead with no id', () => {
    expect(attribute({}, 'controller', index())).toEqual({ rig: UNSCOPED_RIG, agent: 'controller' });
  });
});

describe('normalizeEvent', () => {
  it('normalizes a bead.closed work bead with a cycle time', () => {
    const ev = normalizeEvent(envelope('bead.closed'), index());
    expect(ev).toMatchObject({
      kind: 'closed',
      beadId: 'cockpit-3x7',
      rig: 'gascity-cockpit',
      agent: 'gascity-cockpit/gastown.refinery',
      city: 'blackrim-hq',
      rejectionReason: null,
    });
    expect(ev?.tsMs).toBe(parseTsMs('2026-06-06T02:00:00Z'));
    expect(ev?.createdAtMs).toBe(parseTsMs('2026-06-06T00:00:00Z'));
  });

  it('normalizes a bead.updated reject (non-empty rejection_reason)', () => {
    const ev = normalizeEvent(
      envelope('bead.updated', {}, { metadata: { rejection_reason: 'rebase conflict' } }),
      index(),
    );
    expect(ev).toMatchObject({ kind: 'rejected', rejectionReason: 'rebase conflict', createdAtMs: null });
  });

  it('ignores a bead.updated without a rejection_reason', () => {
    expect(normalizeEvent(envelope('bead.updated'), index())).toBeNull();
    expect(normalizeEvent(envelope('bead.updated', {}, { metadata: { rejection_reason: '' } }), index())).toBeNull();
  });

  it('drops ephemeral and container beads', () => {
    expect(normalizeEvent(envelope('bead.closed', {}, { id: 'cockpit-wisp-x' }), index())).toBeNull();
    expect(normalizeEvent(envelope('bead.closed', {}, { id: 'nim-cwc', issue_type: 'epic' }), index())).toBeNull();
  });

  it('drops unrelated, malformed, or incomplete envelopes', () => {
    expect(normalizeEvent(envelope('session.stopped'), index())).toBeNull();
    expect(normalizeEvent(null, index())).toBeNull();
    expect(normalizeEvent('nope', index())).toBeNull();
    expect(normalizeEvent(envelope('bead.closed', { ts: 'bad' }), index())).toBeNull();
    expect(normalizeEvent({ type: 'bead.closed', ts: '2026-06-06T02:00:00Z', payload: {} }, index())).toBeNull();
    expect(normalizeEvent({ type: 'bead.closed', ts: '2026-06-06T02:00:00Z' }, index())).toBeNull();
    expect(
      normalizeEvent({ type: 'bead.closed', ts: '2026-06-06T02:00:00Z', payload: { bead: { id: '' } } }, index()),
    ).toBeNull();
  });

  it('uses the city hint when the envelope omits the city', () => {
    const ev = normalizeEvent(envelope('bead.closed', { city: null }), index(), 'hinted-city');
    expect(ev?.city).toBe('hinted-city');
  });

  it('falls back to an empty city when neither envelope nor hint has one', () => {
    const ev = normalizeEvent(envelope('bead.closed', { city: null }), index());
    expect(ev?.city).toBe('');
  });

  it('leaves createdAtMs null when the bead has no creation time', () => {
    const ev = normalizeEvent(envelope('bead.closed', {}, { created_at: undefined }), index());
    expect(ev?.createdAtMs).toBeNull();
  });
});
