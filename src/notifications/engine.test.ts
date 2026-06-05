import { describe, expect, it } from 'vitest';
import { NotificationEngine } from './engine';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from './types';
import { PENDING_KIND_PROMPT_FOR_INPUT, PENDING_KIND_TOOL_APPROVAL } from '../api/index';
import type { PendingApproval } from './pending';
import type { FleetEvent } from '../status/index';

const ev = (over: Partial<FleetEvent> = {}): FleetEvent => ({
  seq: 1,
  type: 'mail.sent',
  ts: 't',
  actor: 'mayor',
  city: 'c',
  ...over,
});

const appr = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  city: 'c',
  sessionId: 's1',
  requestId: 'r1',
  kind: PENDING_KIND_TOOL_APPROVAL,
  ...over,
});

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...over,
});

describe('ingestEvent — dedupe', () => {
  it('returns a notification once, then suppresses the same id', () => {
    const engine = new NotificationEngine(prefs());
    expect(engine.ingestEvent(ev({ seq: 5 }))).not.toBeNull();
    expect(engine.ingestEvent(ev({ seq: 5 }))).toBeNull();
    // A different seq is a different signal.
    expect(engine.ingestEvent(ev({ seq: 6 }))).not.toBeNull();
  });

  it('evicts the oldest id past the cap so it can notify again', () => {
    const engine = new NotificationEngine(prefs(), { seenCap: 2 });
    engine.ingestEvent(ev({ seq: 1 }));
    engine.ingestEvent(ev({ seq: 2 }));
    engine.ingestEvent(ev({ seq: 3 })); // evicts seq 1
    expect(engine.ingestEvent(ev({ seq: 1 }))).not.toBeNull();
  });
});

describe('ingestEvent — preference gating', () => {
  it('suppresses everything when the master switch is off', () => {
    const engine = new NotificationEngine(prefs({ enabled: false }));
    expect(engine.ingestEvent(ev({ type: 'mail.sent' }))).toBeNull();
    expect(engine.ingestEvent(ev({ type: 'session.crashed' }))).toBeNull();
  });

  it('mutes a single category but keeps the others', () => {
    const engine = new NotificationEngine(prefs({ mail: false }));
    expect(engine.ingestEvent(ev({ type: 'mail.sent', seq: 1 }))).toBeNull();
    expect(engine.ingestEvent(ev({ type: 'session.crashed', seq: 2 }))).not.toBeNull();
  });

  it('honours a preference change at runtime', () => {
    const engine = new NotificationEngine(prefs({ escalations: false }));
    expect(engine.ingestEvent(ev({ type: 'session.crashed', seq: 1 }))).toBeNull();
    engine.setPrefs(prefs({ escalations: true }));
    expect(engine.ingestEvent(ev({ type: 'session.crashed', seq: 2 }))).not.toBeNull();
  });
});

describe('ingestApprovals — diff', () => {
  it('reports newly-appeared approvals only', () => {
    const engine = new NotificationEngine(prefs());
    const first = engine.ingestApprovals([appr({ requestId: 'r1' }), appr({ requestId: 'r2' })]);
    expect(first).toHaveLength(2);
    // Same snapshot → nothing new.
    expect(engine.ingestApprovals([appr({ requestId: 'r1' }), appr({ requestId: 'r2' })])).toEqual([]);
    // r1 resolved, r3 appeared → only r3 is new.
    const next = engine.ingestApprovals([appr({ requestId: 'r2' }), appr({ requestId: 'r3' })]);
    expect(next.map((n) => n.requestId)).toEqual(['r3']);
  });

  it('re-notifies a resolved approval if a fresh request reappears', () => {
    const engine = new NotificationEngine(prefs());
    engine.ingestApprovals([appr({ requestId: 'r1' })]);
    engine.ingestApprovals([]); // resolved → forgotten
    expect(engine.ingestApprovals([appr({ requestId: 'r1' })])).toHaveLength(1);
  });

  it('carries the respond context and a kind-specific title', () => {
    const engine = new NotificationEngine(prefs());
    const [tool] = engine.ingestApprovals([appr({ city: 'hq', sessionId: 's9', requestId: 'r9' })]);
    expect(tool).toMatchObject({
      category: 'approval',
      severity: 'warning',
      title: 'Tool approval needed',
      city: 'hq',
      sessionId: 's9',
      requestId: 'r9',
      kind: PENDING_KIND_TOOL_APPROVAL,
    });

    const fresh = new NotificationEngine(prefs());
    const [input] = fresh.ingestApprovals([appr({ kind: PENDING_KIND_PROMPT_FOR_INPUT })]);
    expect(input.title).toBe('Agent waiting for input');
  });

  it('tracks pending while muted so re-enabling does not flood', () => {
    const engine = new NotificationEngine(prefs({ approvals: false }));
    expect(engine.ingestApprovals([appr({ requestId: 'r1' })])).toEqual([]);
    engine.setPrefs(prefs({ approvals: true }));
    // r1 was already tracked → not re-announced; only the new r2 fires.
    const out = engine.ingestApprovals([appr({ requestId: 'r1' }), appr({ requestId: 'r2' })]);
    expect(out.map((n) => n.requestId)).toEqual(['r2']);
  });
});

describe('reset', () => {
  it('forgets seen events and active approvals (supervisor restart)', () => {
    const engine = new NotificationEngine(prefs());
    engine.ingestEvent(ev({ seq: 1 }));
    engine.ingestApprovals([appr({ requestId: 'r1' })]);

    engine.reset();

    expect(engine.ingestEvent(ev({ seq: 1 }))).not.toBeNull();
    expect(engine.ingestApprovals([appr({ requestId: 'r1' })])).toHaveLength(1);
  });
});
