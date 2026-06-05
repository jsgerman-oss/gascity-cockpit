// Pure presentation helpers for the status panes.
//
// Kept free of `vscode` so the label/description/icon logic is unit-testable
// (PRD: behaviour lives behind the testable seam; the tree-view glue stays
// thin). `views.ts` maps these strings onto VS Code TreeItems + ThemeIcons.
import type {
  AgentResponse,
  CityInfo,
  EventStreamStatus,
  FleetEvent,
  SessionResponse,
  SupervisorHealth,
} from './types.ts';

/** A small, theme-icon-agnostic status enum used to pick an icon in the glue. */
export type StatusKind = 'ok' | 'busy' | 'idle' | 'warn' | 'error' | 'off';

/** Format a duration in seconds as a compact `1d 2h`, `3h 4m`, `5m`, `9s`. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ---- supervisor -----------------------------------------------------------

export function supervisorLabel(health: SupervisorHealth | null): string {
  return health ? `Supervisor — ${health.status}` : 'Supervisor — unknown';
}

export function supervisorDescription(health: SupervisorHealth | null): string {
  if (!health) return 'not connected';
  const parts = [
    health.version || 'dev',
    `${health.cities_running}/${health.cities_total} cities`,
    `up ${formatUptime(health.uptime_sec)}`,
  ];
  return parts.join(' · ');
}

export function supervisorStatusKind(health: SupervisorHealth | null): StatusKind {
  if (!health) return 'off';
  if (health.startup && !health.startup.ready) return 'warn';
  return health.status === 'ok' || health.status === 'healthy' ? 'ok' : 'warn';
}

// ---- city -----------------------------------------------------------------

export function cityLabel(city: CityInfo): string {
  return city.name;
}

export function cityDescription(city: CityInfo): string {
  if (!city.running) return city.status ? `stopped · ${city.status}` : 'stopped';
  return city.status || 'running';
}

export function cityStatusKind(city: CityInfo): StatusKind {
  if (city.error) return 'error';
  return city.running ? 'ok' : 'off';
}

// ---- agent ----------------------------------------------------------------

export function agentLabel(agent: AgentResponse): string {
  return agent.display_name || agent.name;
}

export function agentDescription(agent: AgentResponse): string {
  const parts: string[] = [agent.state];
  if (agent.active_bead) parts.push(agent.active_bead);
  if (agent.model) parts.push(agent.model);
  if (typeof agent.context_pct === 'number' && agent.context_pct > 0) {
    parts.push(`ctx ${agent.context_pct}%`);
  }
  return parts.filter(Boolean).join(' · ');
}

export function agentStatusKind(agent: AgentResponse): StatusKind {
  if (agent.suspended) return 'off';
  if (!agent.available) return 'warn';
  if (agent.running) return 'busy';
  return 'idle';
}

// ---- session --------------------------------------------------------------

export function sessionLabel(session: SessionResponse): string {
  return session.title || session.display_name || session.session_name || session.id;
}

export function sessionDescription(session: SessionResponse): string {
  const parts: string[] = [session.state];
  if (session.active_bead) parts.push(session.active_bead);
  if (session.template) parts.push(session.template);
  if (session.provider) parts.push(session.provider);
  return parts.filter(Boolean).join(' · ');
}

export function sessionStatusKind(session: SessionResponse): StatusKind {
  if (session.running) return 'busy';
  if (session.attached) return 'ok';
  return 'idle';
}

// ---- event feed -----------------------------------------------------------

export function eventLabel(event: FleetEvent): string {
  return event.type;
}

export function eventDescription(event: FleetEvent): string {
  const parts: string[] = [];
  if (event.city) parts.push(event.city);
  if (event.actor) parts.push(event.actor);
  if (event.message) parts.push(event.message);
  else if (event.subject) parts.push(event.subject);
  return parts.join(' · ');
}

/**
 * Coarse severity for an event type, so the feed can tint failures/crashes
 * without enumerating every event variant.
 */
export function eventStatusKind(type: string): StatusKind {
  if (/(crash|fail|stalled|stranded|quarantin|critical|timeout|killed)/i.test(type)) {
    return 'error';
  }
  if (/(warn|drain|suspend|stop|undrained)/i.test(type)) return 'warn';
  return 'ok';
}

// ---- accessibility ---------------------------------------------------------
//
// VS Code announces a TreeItem's label + description, but the severity an item
// conveys through its *icon* (ok / busy / warn / error / off) is invisible to
// assistive tech. These compose a single accessible name — label, then the
// description's words — so a screen reader hears everything in one phrase.
// `views.ts` sets the result as `TreeItem.accessibilityInformation`.

/** Join a label with its description into one accessible phrase, dropping empties. */
function accessibleName(label: string, description?: string): string {
  return [label, description].filter((part) => part && part.length).join(', ');
}

export function accessibleSupervisorLabel(health: SupervisorHealth | null): string {
  return accessibleName(supervisorLabel(health), supervisorDescription(health));
}

export function accessibleCityLabel(city: CityInfo): string {
  const base = accessibleName(`City ${city.name}`, cityDescription(city));
  return city.error ? `${base}, error` : base;
}

export function accessibleAgentLabel(agent: AgentResponse): string {
  const base = accessibleName(agentLabel(agent), agentDescription(agent));
  return !agent.available && agent.unavailable_reason ? `${base}, unavailable: ${agent.unavailable_reason}` : base;
}

export function accessibleSessionLabel(session: SessionResponse): string {
  return accessibleName(sessionLabel(session), sessionDescription(session));
}

export function accessibleEventLabel(event: FleetEvent): string {
  return accessibleName(eventLabel(event), eventDescription(event));
}

// ---- event stream status --------------------------------------------------

export function eventStreamStatusKind(status: EventStreamStatus | null): StatusKind {
  if (!status) return 'off';
  switch (status.state) {
    case 'open':
      return 'ok';
    case 'connecting':
      return 'busy';
    case 'reconnecting':
      return 'warn';
    case 'stopped':
    default:
      return 'off';
  }
}
