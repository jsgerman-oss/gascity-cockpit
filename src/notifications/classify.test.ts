import { describe, expect, it } from 'vitest';
import { classifyEvent, escalationTypes, isEscalationType } from './classify';
import type { FleetEvent } from '../status/index';

const ev = (over: Partial<FleetEvent> = {}): FleetEvent => ({
  seq: 7,
  type: 'session.updated',
  ts: 't',
  actor: 'gastown.capable',
  city: 'blackrim-hq',
  ...over,
});

describe('classifyEvent — mail', () => {
  it('turns mail.sent into an info notification keyed by seq', () => {
    const n = classifyEvent(ev({ type: 'mail.sent', seq: 12, actor: 'mayor', message: 'BLOCKED: dolt' }));
    expect(n).toEqual({
      id: 'mail:12',
      category: 'mail',
      severity: 'info',
      title: 'New mail',
      detail: 'from mayor: BLOCKED: dolt',
      city: 'blackrim-hq',
    });
  });

  it('drops the body when the mail event carries no message', () => {
    const n = classifyEvent(ev({ type: 'mail.sent', actor: 'mayor', message: undefined }));
    expect(n?.detail).toBe('from mayor');
  });

  it('ignores other mail traffic (read/replied/archived)', () => {
    for (const type of ['mail.read', 'mail.replied', 'mail.archived', 'mail.marked_read']) {
      expect(classifyEvent(ev({ type }))).toBeNull();
    }
  });
});

describe('classifyEvent — escalations', () => {
  it('turns each escalation type into a warning keyed by seq', () => {
    const n = classifyEvent(ev({ type: 'session.crashed', seq: 3, actor: 'rig/polecat', message: 'exit 1' }));
    expect(n).toEqual({
      id: 'esc:3',
      category: 'escalation',
      severity: 'warning',
      title: 'Session crashed',
      detail: 'rig/polecat · exit 1',
      city: 'blackrim-hq',
    });
  });

  it('labels every declared escalation type', () => {
    for (const type of escalationTypes()) {
      const n = classifyEvent(ev({ type }));
      expect(n?.category).toBe('escalation');
      expect(n?.severity).toBe('warning');
      expect(n?.title).toBeTruthy();
    }
  });

  it('falls back to the subject when there is no message', () => {
    const n = classifyEvent(ev({ type: 'order.failed', actor: '', subject: 'order-9', message: undefined }));
    expect(n?.detail).toBe('order-9');
  });

  it('treats only the curated set as escalations', () => {
    expect(isEscalationType('session.crashed')).toBe(true);
    expect(isEscalationType('session.quarantined')).toBe(true);
    // Routine lifecycle is not an escalation.
    expect(isEscalationType('session.idle_killed')).toBe(false);
    expect(isEscalationType('session.woke')).toBe(false);
    expect(isEscalationType('session.updated')).toBe(false);
  });
});

describe('classifyEvent — non-notable', () => {
  it('returns null for everything outside mail.sent and the escalation set', () => {
    for (const type of ['session.updated', 'session.woke', 'bead.updated', 'city.suspended', 'order.completed']) {
      expect(classifyEvent(ev({ type }))).toBeNull();
    }
  });

  it('omits the city for supervisor-global events', () => {
    const n = classifyEvent(ev({ type: 'request.failed', city: '' }));
    expect(n).not.toHaveProperty('city');
  });

  it('omits the detail when neither actor, message nor subject is present', () => {
    const n = classifyEvent(ev({ type: 'session.stranded', actor: '', message: undefined, subject: undefined }));
    expect(n).not.toHaveProperty('detail');
  });
});
