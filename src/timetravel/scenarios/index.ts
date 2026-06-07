// Committed replay-to-regression scenarios (cockpit-6x0).
//
// Each `*.scenario.json` here is a frozen replay window — a recorded event
// sequence plus the exact derived state the recorder produced from it (captured
// via `captureScenario`). `scenario.regression.test.ts` replays each one back
// through a fresh `EventTimeline` and asserts the derived state has not drifted.
//
// Adding a scenario: save one from the Event Time-Travel panel (the "Save
// scenario" button serializes the live recording in this exact format), drop the
// JSON file in this folder, and append it to {@link SAVED_SCENARIOS}. Validation
// runs at load, so a malformed or stale-version fixture fails fast and loudly.
import { coerceScenario, type ReplayScenario } from '../scenario.ts';
import incidentReplay from './incident-replay.scenario.json';
import reconnectDedup from './reconnect-dedup.scenario.json';
import ringOverflow from './ring-overflow.scenario.json';

/** Every committed scenario, validated against the current format on import. */
export const SAVED_SCENARIOS: readonly ReplayScenario[] = [
  coerceScenario(incidentReplay),
  coerceScenario(reconnectDedup),
  coerceScenario(ringOverflow),
];
