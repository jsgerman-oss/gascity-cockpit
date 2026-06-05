import { describe, expect, it } from 'vitest';
import {
  accessibleAgentLabel,
  accessibleCityLabel,
  accessibleEventLabel,
  accessibleSessionLabel,
  accessibleSupervisorLabel,
  agentDescription,
  agentLabel,
  agentStatusKind,
  cityDescription,
  cityStatusKind,
  eventDescription,
  eventLabel,
  eventStatusKind,
  eventStreamStatusKind,
  formatUptime,
  sessionDescription,
  sessionLabel,
  sessionStatusKind,
  supervisorDescription,
  supervisorStatusKind,
} from './format';
import type { AgentResponse, CityInfo, FleetEvent, SessionResponse, SupervisorHealth } from './types';

const agent = (over: Partial<AgentResponse> = {}): AgentResponse => ({
  name: 'gastown.rictus',
  running: false,
  suspended: false,
  state: 'idle',
  available: true,
  ...over,
});

const session = (over: Partial<SessionResponse> = {}): SessionResponse => ({
  id: 'sess-1',
  template: 'polecat',
  state: 'running',
  title: 'Polecat work',
  provider: 'anthropic',
  session_name: 'gastown.rictus',
  created_at: '2026-06-05T00:00:00Z',
  attached: false,
  running: true,
  ...over,
});

const health = (over: Partial<SupervisorHealth> = {}): SupervisorHealth => ({
  status: 'ok',
  version: '0.1.0',
  uptime_sec: 3661,
  cities_total: 2,
  cities_running: 1,
  startup: { ready: true },
  ...over,
});

describe('formatUptime', () => {
  it('formats days, hours, minutes, seconds at decreasing scales', () => {
    expect(formatUptime(90_061)).toBe('1d 1h');
    expect(formatUptime(3661)).toBe('1h 1m');
    expect(formatUptime(125)).toBe('2m 5s');
    expect(formatUptime(9)).toBe('9s');
  });

  it('returns a dash for invalid input', () => {
    expect(formatUptime(-1)).toBe('—');
    expect(formatUptime(Number.NaN)).toBe('—');
  });
});

describe('supervisor formatting', () => {
  it('summarises version, city counts, and uptime', () => {
    expect(supervisorDescription(health())).toBe('0.1.0 · 1/2 cities · up 1h 1m');
  });

  it('reports off / warn / ok status kinds', () => {
    expect(supervisorStatusKind(null)).toBe('off');
    expect(supervisorStatusKind(health({ startup: { ready: false, phase: 'booting' } }))).toBe('warn');
    expect(supervisorStatusKind(health())).toBe('ok');
    expect(supervisorStatusKind(health({ status: 'degraded' }))).toBe('warn');
  });
});

describe('city formatting', () => {
  const city = (over: Partial<CityInfo> = {}): CityInfo => ({
    name: 'blackrim-hq',
    path: '/Users/jayse/Code',
    running: true,
    ...over,
  });

  it('describes running and stopped cities', () => {
    expect(cityDescription(city({ status: 'healthy' }))).toBe('healthy');
    expect(cityDescription(city({ running: false }))).toBe('stopped');
    expect(cityDescription(city({ running: false, status: 'suspended' }))).toBe('stopped · suspended');
  });

  it('flags errored cities', () => {
    expect(cityStatusKind(city({ error: 'boom' }))).toBe('error');
    expect(cityStatusKind(city({ running: false }))).toBe('off');
    expect(cityStatusKind(city())).toBe('ok');
  });
});

describe('agent formatting', () => {
  it('prefers the display name and joins description parts', () => {
    const a = agent({ display_name: 'Rictus', state: 'working', active_bead: 'cockpit-1ll.6', model: 'opus', context_pct: 42 });
    expect(agentLabel(a)).toBe('Rictus');
    expect(agentDescription(a)).toBe('working · cockpit-1ll.6 · opus · ctx 42%');
  });

  it('falls back to the name and omits empty fields', () => {
    expect(agentLabel(agent())).toBe('gastown.rictus');
    expect(agentDescription(agent({ state: 'idle' }))).toBe('idle');
  });

  it('derives status kind from running / suspended / available', () => {
    expect(agentStatusKind(agent({ suspended: true }))).toBe('off');
    expect(agentStatusKind(agent({ available: false }))).toBe('warn');
    expect(agentStatusKind(agent({ running: true }))).toBe('busy');
    expect(agentStatusKind(agent())).toBe('idle');
  });
});

describe('session formatting', () => {
  it('labels from the title and falls back through to the id', () => {
    expect(sessionLabel(session())).toBe('Polecat work');
    expect(sessionLabel(session({ title: '', display_name: '', session_name: '' }))).toBe('sess-1');
  });

  it('describes state and key fields', () => {
    expect(sessionDescription(session({ state: 'running', active_bead: 'b1', template: 'polecat' }))).toBe(
      'running · b1 · polecat · anthropic',
    );
  });

  it('derives status kind from running / attached', () => {
    expect(sessionStatusKind(session({ running: true }))).toBe('busy');
    expect(sessionStatusKind(session({ running: false, attached: true }))).toBe('ok');
    expect(sessionStatusKind(session({ running: false, attached: false }))).toBe('idle');
  });
});

describe('event formatting', () => {
  const event = (over: Partial<FleetEvent> = {}): FleetEvent => ({
    seq: 1,
    type: 'session.updated',
    ts: '2026-06-05T00:00:00Z',
    actor: 'controller',
    city: 'blackrim-hq',
    ...over,
  });

  it('labels with the type and joins city/actor/message', () => {
    expect(eventLabel(event())).toBe('session.updated');
    expect(eventDescription(event({ message: 'woke' }))).toBe('blackrim-hq · controller · woke');
  });

  it('uses subject when no message is present', () => {
    expect(eventDescription(event({ subject: 'sess-1', message: undefined }))).toBe('blackrim-hq · controller · sess-1');
  });

  it('classifies failure / warning / normal severity from the type', () => {
    expect(eventStatusKind('session.crashed')).toBe('error');
    expect(eventStatusKind('gc.store.disk_critical')).toBe('error');
    expect(eventStatusKind('session.draining')).toBe('warn');
    expect(eventStatusKind('session.updated')).toBe('ok');
  });
});

describe('eventStreamStatusKind', () => {
  it('maps stream state to a status kind', () => {
    expect(eventStreamStatusKind(null)).toBe('off');
    expect(eventStreamStatusKind({ state: 'open', detail: '', attempt: 0 })).toBe('ok');
    expect(eventStreamStatusKind({ state: 'connecting', detail: '', attempt: 0 })).toBe('busy');
    expect(eventStreamStatusKind({ state: 'reconnecting', detail: '', attempt: 2 })).toBe('warn');
    expect(eventStreamStatusKind({ state: 'stopped', detail: '', attempt: 0 })).toBe('off');
  });
});

describe('accessible labels', () => {
  const city = (over: Partial<CityInfo> = {}): CityInfo => ({
    name: 'blackrim-hq',
    path: '/Users/jayse/Code',
    running: true,
    ...over,
  });

  it('folds the supervisor description into one accessible phrase', () => {
    expect(accessibleSupervisorLabel(health())).toBe('Supervisor — ok, 0.1.0 · 1/2 cities · up 1h 1m');
    expect(accessibleSupervisorLabel(null)).toBe('Supervisor — unknown, not connected');
  });

  it('names a city and appends an error marker when present', () => {
    expect(accessibleCityLabel(city({ status: 'healthy' }))).toBe('City blackrim-hq, healthy');
    expect(accessibleCityLabel(city({ error: 'boom' }))).toBe('City blackrim-hq, running, error');
  });

  it('spells out an agent and its unavailability reason', () => {
    expect(accessibleAgentLabel(agent({ state: 'idle' }))).toBe('gastown.rictus, idle');
    expect(accessibleAgentLabel(agent({ available: false, unavailable_reason: 'drained' }))).toBe(
      'gastown.rictus, idle, unavailable: drained',
    );
  });

  it('joins a session label with its description', () => {
    expect(accessibleSessionLabel(session({ state: 'running', active_bead: 'b1', template: 'polecat' }))).toBe(
      'Polecat work, running · b1 · polecat · anthropic',
    );
  });

  it('joins an event label with its description', () => {
    const evt: FleetEvent = { seq: 1, type: 'session.updated', ts: '', actor: 'controller', city: 'blackrim-hq', message: 'woke' };
    expect(accessibleEventLabel(evt)).toBe('session.updated, blackrim-hq · controller · woke');
  });
});
