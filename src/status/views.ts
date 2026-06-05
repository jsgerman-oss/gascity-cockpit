// VS Code adapter for the live status panes.
//
// Intentionally thin (PRD: VS Code-API-bound glue is kept small and excluded
// from heavy unit testing). It maps the `vscode`-free FleetStatusStore onto two
// TreeDataProviders — a "Fleet" tree (supervisor → cities → agents/sessions)
// and an "Event Feed" tree — and re-renders on the store's single change signal.
// All label/description/severity logic lives in the tested `format.ts`.
import * as vscode from 'vscode';
import { CITY_PLACEHOLDER } from '../cities/index.ts';
import type { Disposable } from '../discovery/index.ts';
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
  cityLabel,
  cityStatusKind,
  eventDescription,
  eventLabel,
  eventStatusKind,
  sessionDescription,
  sessionLabel,
  sessionStatusKind,
  supervisorDescription,
  supervisorLabel,
  supervisorStatusKind,
  type StatusKind,
} from './format.ts';
import type { FleetStatusStore } from './store.ts';
import type { LiveStatus } from './live.ts';
import type { AgentResponse, CityInfo, FleetEvent, SessionResponse } from './types.ts';

const FLEET_VIEW = 'gascityCockpit.fleet';
const EVENTS_VIEW = 'gascityCockpit.events';
const REFRESH_COMMAND = 'gascityCockpit.refreshStatus';

type FleetNode =
  | { kind: 'supervisor' }
  | { kind: 'city'; city: CityInfo }
  | { kind: 'group'; cityName: string; group: 'agents' | 'sessions' }
  | { kind: 'agent'; cityName: string; agent: AgentResponse }
  | { kind: 'session'; cityName: string; session: SessionResponse }
  | { kind: 'notice'; id: string; label: string; description?: string; icon?: string };

type EventNode =
  | { kind: 'event'; event: FleetEvent }
  | { kind: 'notice'; id: string; label: string; description?: string };

function statusIcon(kind: StatusKind): vscode.ThemeIcon {
  switch (kind) {
    case 'ok':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    case 'busy':
      return new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.blue'));
    case 'idle':
      return new vscode.ThemeIcon('circle-outline');
    case 'warn':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    case 'off':
    default:
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
  }
}

/** The Fleet tree: supervisor → cities → (Agents | Sessions) → items. */
export class FleetTreeProvider implements vscode.TreeDataProvider<FleetNode>, Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly storeSub: Disposable;

  constructor(private readonly store: FleetStatusStore) {
    this.storeSub = store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  dispose(): void {
    this.storeSub.dispose();
    this._onDidChangeTreeData.dispose();
  }

  getChildren(node?: FleetNode): FleetNode[] {
    const { state } = this.store;
    if (!node) {
      const roots: FleetNode[] = [{ kind: 'supervisor' }];
      if (state.lastError) {
        roots.push({ kind: 'notice', id: 'error', label: state.lastError, description: 'error' });
      }
      for (const city of state.cities) roots.push({ kind: 'city', city });
      if (!state.cities.length && !state.lastError) {
        // While the first snapshot is in flight, say so rather than claiming
        // there are no cities (cockpit-1ll.16). Shared copy with the Beads pane.
        roots.push(
          state.loading
            ? { kind: 'notice', id: 'loading', label: CITY_PLACEHOLDER.connecting, icon: 'loading~spin' }
            : { kind: 'notice', id: 'no-cities', label: CITY_PLACEHOLDER.noCities },
        );
      }
      for (const err of state.partialErrors) {
        roots.push({ kind: 'notice', id: `partial:${err}`, label: err, description: 'partial' });
      }
      return roots;
    }
    if (node.kind === 'city') {
      if (!node.city.running) return [];
      return [
        { kind: 'group', cityName: node.city.name, group: 'agents' },
        { kind: 'group', cityName: node.city.name, group: 'sessions' },
      ];
    }
    if (node.kind === 'group') {
      if (node.group === 'agents') {
        const agents = state.agentsByCity[node.cityName] ?? [];
        if (!agents.length) return [{ kind: 'notice', id: `no-agents:${node.cityName}`, label: 'No agents' }];
        return agents.map((agent) => ({ kind: 'agent', cityName: node.cityName, agent }));
      }
      const sessions = state.sessionsByCity[node.cityName] ?? [];
      if (!sessions.length) return [{ kind: 'notice', id: `no-sessions:${node.cityName}`, label: 'No sessions' }];
      return sessions.map((session) => ({ kind: 'session', cityName: node.cityName, session }));
    }
    return [];
  }

  getTreeItem(node: FleetNode): vscode.TreeItem {
    const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case 'supervisor': {
        const health = this.store.state.health;
        const item = new vscode.TreeItem(supervisorLabel(health), None);
        item.id = 'supervisor';
        item.description = supervisorDescription(health);
        item.iconPath = statusIcon(supervisorStatusKind(health));
        item.contextValue = 'gascitySupervisor';
        item.accessibilityInformation = { label: accessibleSupervisorLabel(health) };
        if (health) {
          const md = new vscode.MarkdownString();
          md.appendMarkdown(`**Supervisor** — ${health.status}\n\n`);
          md.appendMarkdown(`- Version: \`${health.version || 'dev'}\`\n`);
          if (health.build_id) md.appendMarkdown(`- Build: \`${health.build_id}\`\n`);
          md.appendMarkdown(`- Cities: ${health.cities_running}/${health.cities_total} running\n`);
          item.tooltip = md;
        }
        return item;
      }
      case 'city': {
        const item = new vscode.TreeItem(cityLabel(node.city), node.city.running ? Collapsed : None);
        item.id = `city:${node.city.name}`;
        item.description = cityDescription(node.city);
        item.iconPath = statusIcon(cityStatusKind(node.city));
        item.contextValue = 'gascityCity';
        item.accessibilityInformation = { label: accessibleCityLabel(node.city) };
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${node.city.name}**\n\n- Path: \`${node.city.path}\`\n`);
        if (node.city.error) md.appendMarkdown(`- Error: ${node.city.error}\n`);
        item.tooltip = md;
        return item;
      }
      case 'group': {
        const count =
          node.group === 'agents'
            ? (this.store.state.agentsByCity[node.cityName] ?? []).length
            : (this.store.state.sessionsByCity[node.cityName] ?? []).length;
        const title = node.group === 'agents' ? 'Agents' : 'Sessions';
        const item = new vscode.TreeItem(`${title} (${count})`, Expanded);
        item.id = `group:${node.cityName}:${node.group}`;
        item.iconPath = new vscode.ThemeIcon(node.group === 'agents' ? 'organization' : 'comment-discussion');
        item.contextValue = `gascityGroup.${node.group}`;
        item.accessibilityInformation = { label: `${title}, ${count}` };
        return item;
      }
      case 'agent': {
        const item = new vscode.TreeItem(agentLabel(node.agent), None);
        item.id = `agent:${node.cityName}:${node.agent.name}`;
        item.description = agentDescription(node.agent);
        item.iconPath = statusIcon(agentStatusKind(node.agent));
        item.contextValue = 'gascityAgent';
        item.tooltip = agentTooltip(node.cityName, node.agent);
        item.accessibilityInformation = { label: accessibleAgentLabel(node.agent) };
        return item;
      }
      case 'session': {
        const item = new vscode.TreeItem(sessionLabel(node.session), None);
        item.id = `session:${node.cityName}:${node.session.id}`;
        item.description = sessionDescription(node.session);
        item.iconPath = statusIcon(sessionStatusKind(node.session));
        item.contextValue = 'gascitySession';
        item.tooltip = sessionTooltip(node.cityName, node.session);
        item.accessibilityInformation = { label: accessibleSessionLabel(node.session) };
        return item;
      }
      case 'notice':
      default: {
        const item = new vscode.TreeItem(node.label, None);
        item.id = `notice:${node.id}`;
        if (node.description) item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon ?? 'info');
        item.contextValue = 'gascityNotice';
        item.accessibilityInformation = { label: node.description ? `${node.label}, ${node.description}` : node.label };
        return item;
      }
    }
  }
}

/** The Event Feed tree: a flat, newest-first list of supervisor events. */
export class EventsTreeProvider implements vscode.TreeDataProvider<EventNode>, Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly storeSub: Disposable;

  constructor(private readonly store: FleetStatusStore) {
    this.storeSub = store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  dispose(): void {
    this.storeSub.dispose();
    this._onDidChangeTreeData.dispose();
  }

  getChildren(node?: EventNode): EventNode[] {
    if (node) return [];
    const events = this.store.state.events;
    if (!events.length) return [{ kind: 'notice', id: 'no-events', label: 'No events yet' }];
    return events.map((event) => ({ kind: 'event', event }));
  }

  getTreeItem(node: EventNode): vscode.TreeItem {
    if (node.kind === 'notice') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = `notice:${node.id}`;
      item.iconPath = new vscode.ThemeIcon('info');
      item.accessibilityInformation = { label: node.label };
      return item;
    }
    const event = node.event;
    const item = new vscode.TreeItem(eventLabel(event), vscode.TreeItemCollapsibleState.None);
    item.id = `event:${event.seq}`;
    item.description = eventDescription(event);
    item.iconPath = statusIcon(eventStatusKind(event.type));
    item.contextValue = 'gascityEvent';
    item.accessibilityInformation = { label: accessibleEventLabel(event) };
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${event.type}**\n\n`);
    if (event.ts) md.appendMarkdown(`- Time: ${event.ts}\n`);
    if (event.city) md.appendMarkdown(`- City: ${event.city}\n`);
    if (event.actor) md.appendMarkdown(`- Actor: ${event.actor}\n`);
    if (event.subject) md.appendMarkdown(`- Subject: \`${event.subject}\`\n`);
    if (event.message) md.appendMarkdown(`\n${event.message}\n`);
    md.appendMarkdown(`\n_seq ${event.seq}_`);
    item.tooltip = md;
    return item;
  }
}

function agentTooltip(cityName: string, agent: AgentResponse): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${agentLabel(agent)}** — ${agent.state}\n\n`);
  md.appendMarkdown(`- City: ${cityName}\n`);
  if (agent.rig) md.appendMarkdown(`- Rig: ${agent.rig}\n`);
  if (agent.pool) md.appendMarkdown(`- Pool: ${agent.pool}\n`);
  if (agent.provider) md.appendMarkdown(`- Provider: ${agent.provider}\n`);
  if (agent.model) md.appendMarkdown(`- Model: ${agent.model}\n`);
  if (agent.active_bead) md.appendMarkdown(`- Active bead: \`${agent.active_bead}\`\n`);
  if (typeof agent.context_pct === 'number') md.appendMarkdown(`- Context: ${agent.context_pct}%\n`);
  md.appendMarkdown(`- Running: ${agent.running} · Suspended: ${agent.suspended}\n`);
  if (!agent.available && agent.unavailable_reason) {
    md.appendMarkdown(`- Unavailable: ${agent.unavailable_reason}\n`);
  }
  return md;
}

function sessionTooltip(cityName: string, session: SessionResponse): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${sessionLabel(session)}** — ${session.state}\n\n`);
  md.appendMarkdown(`- City: ${cityName}\n`);
  md.appendMarkdown(`- Id: \`${session.id}\`\n`);
  if (session.template) md.appendMarkdown(`- Template: ${session.template}\n`);
  if (session.provider) md.appendMarkdown(`- Provider: ${session.provider}\n`);
  if (session.model) md.appendMarkdown(`- Model: ${session.model}\n`);
  if (session.active_bead) md.appendMarkdown(`- Active bead: \`${session.active_bead}\`\n`);
  if (session.rig) md.appendMarkdown(`- Rig: ${session.rig}\n`);
  md.appendMarkdown(`- Running: ${session.running} · Attached: ${session.attached}\n`);
  return md;
}

/**
 * Register the two status tree views and the refresh command, wiring view
 * titles/messages to the store. Disposables are pushed onto the context.
 */
export function registerStatusViews(
  context: vscode.ExtensionContext,
  store: FleetStatusStore,
  live: LiveStatus,
): void {
  const fleetProvider = new FleetTreeProvider(store);
  const eventsProvider = new EventsTreeProvider(store);
  const fleetView = vscode.window.createTreeView(FLEET_VIEW, { treeDataProvider: fleetProvider });
  const eventsView = vscode.window.createTreeView(EVENTS_VIEW, { treeDataProvider: eventsProvider });

  const syncTitles = () => {
    const { state } = store;
    const running = state.cities.filter((c) => c.running).length;
    fleetView.description = state.cities.length ? `${running}/${state.cities.length} running` : undefined;
    const stream = state.eventStream;
    eventsView.description = stream && stream.state !== 'open' ? stream.state : `${state.events.length}`;
    eventsView.message =
      stream && (stream.state === 'reconnecting' || stream.state === 'connecting')
        ? `Event stream ${stream.detail}`
        : undefined;
  };
  syncTitles();

  context.subscriptions.push(
    fleetProvider,
    eventsProvider,
    fleetView,
    eventsView,
    store.onDidChange(() => syncTitles()),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => live.refreshNow()),
  );
}
