// Public surface of the event time-travel feature (cockpit-21l.6).
//
// The editor glue (`../views/timeTravel.ts`) and the feature descriptor import
// from here; nothing in this barrel imports `vscode`, so the whole core stays in
// the Seam-1 test layer. The webview HTML builder is Seam-2 (pure string), also
// exported here for its glue + tests.
export type {
  EventSeverity,
  FleetEvent,
  TimelineBounds,
  TimelineRow,
  TimelineSnapshot,
} from './types.ts';

export { EventTimeline, TIMELINE_CAP } from './recorder.ts';
export { buildTimelineView } from './view.ts';
export { escapeHtml, renderTimeTravelHtml, type TimeTravelHtmlOptions } from './webview.ts';

export {
  captureScenario,
  captureTimelineScenario,
  coerceScenario,
  diffSnapshots,
  parseScenario,
  runScenario,
  SCENARIO_FORMAT_VERSION,
  serializeScenario,
  type CaptureOptions,
  type ReplayScenario,
  type ScenarioDrift,
} from './scenario.ts';
export { SAVED_SCENARIOS } from './scenarios/index.ts';
