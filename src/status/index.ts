// Public surface of the live status feature (cockpit-1ll.6).
//
// The editor glue (extension.ts, views.ts) imports from here; nothing in this
// barrel imports `vscode`, so the whole status core stays in the Seam-1 test
// layer. `views.ts` is intentionally excluded — it is the thin VS Code adapter.
export type {
  AgentResponse,
  CityInfo,
  EventStreamState,
  EventStreamStatus,
  FleetEvent,
  FleetSnapshot,
  FleetStatusState,
  SessionResponse,
  SupervisorHealth,
} from './types.ts';

export { EVENTS_CAP, FleetStatusStore } from './store.ts';

export {
  affectsStatusPanes,
  DEFAULT_EVENT_STREAM_OPTIONS,
  parseFleetEvent,
  SupervisorEventStream,
  type EventStreamDeps,
  type EventStreamOptions,
  type OpenStream,
  type Sleep,
} from './events.ts';

export { fetchFleetSnapshot, type FetchSnapshotOptions } from './snapshot.ts';

export {
  DEFAULT_LIVE_STATUS_OPTIONS,
  LiveStatus,
  type LiveStatusDeps,
  type LiveStatusOptions,
  type StatusEndpoint,
} from './live.ts';

export {
  agentDescription,
  agentLabel,
  agentStatusKind,
  cityDescription,
  cityLabel,
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
  supervisorLabel,
  supervisorStatusKind,
  type StatusKind,
} from './format.ts';
