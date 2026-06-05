import { describe, expect, it } from 'vitest';
import { approvalActions, approvalNotification, notificationMessage } from './format';
import {
  PENDING_KIND_PROMPT_FOR_INPUT,
  PENDING_KIND_TOOL_APPROVAL,
  RESPOND_ACTION_ALLOW,
  RESPOND_ACTION_DENY,
} from '../api/index';
import type { CockpitNotification } from './types';

const base: CockpitNotification = {
  id: 'x',
  category: 'mail',
  severity: 'info',
  title: 'New mail',
};

describe('notificationMessage', () => {
  it('joins title and detail when a detail is present', () => {
    expect(notificationMessage({ ...base, detail: 'from mayor' })).toBe('New mail — from mayor');
  });

  it('uses the title alone when there is no detail', () => {
    expect(notificationMessage(base)).toBe('New mail');
  });
});

describe('approvalActions', () => {
  it('offers Allow/Deny for a tool-approval, mapped to respond tokens', () => {
    const n: CockpitNotification = {
      id: 'appr:c/s/r',
      category: 'approval',
      severity: 'warning',
      title: 'Tool approval needed',
      kind: PENDING_KIND_TOOL_APPROVAL,
    };
    expect(approvalActions(n)).toEqual([
      { label: 'Allow', action: RESPOND_ACTION_ALLOW },
      { label: 'Deny', action: RESPOND_ACTION_DENY },
    ]);
  });

  it('is notify-only for a prompt-for-input (no safe default action)', () => {
    const n: CockpitNotification = {
      id: 'appr:c/s/r',
      category: 'approval',
      severity: 'warning',
      title: 'Agent waiting for input',
      kind: PENDING_KIND_PROMPT_FOR_INPUT,
    };
    expect(approvalActions(n)).toEqual([]);
  });

  it('has no inline actions for non-approval notifications', () => {
    expect(approvalActions(base)).toEqual([]);
    expect(approvalActions({ ...base, category: 'escalation', severity: 'warning' })).toEqual([]);
  });
});

describe('approvalNotification', () => {
  it('renders a tool-approval with the respond context and a stable id', () => {
    expect(
      approvalNotification({ city: 'hq', sessionId: 's1', requestId: 'r1', kind: PENDING_KIND_TOOL_APPROVAL }),
    ).toEqual({
      id: 'appr:hq/s1/r1',
      category: 'approval',
      severity: 'warning',
      title: 'Tool approval needed',
      detail: 's1 · hq',
      city: 'hq',
      sessionId: 's1',
      requestId: 'r1',
      kind: PENDING_KIND_TOOL_APPROVAL,
    });
  });

  it('titles a prompt-for-input differently', () => {
    const n = approvalNotification({ city: 'hq', sessionId: 's2', requestId: 'r2', kind: PENDING_KIND_PROMPT_FOR_INPUT });
    expect(n.title).toBe('Agent waiting for input');
  });
});
