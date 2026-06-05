// Test fixtures for the town-topology core. Mirrors `src/beads/fixtures.ts`:
// small builders with sensible defaults so tests state only what they assert.
import type { AgentResponse, CityInfo, SupervisorHealth } from '../status/index.ts';
import type { TownStateInput } from './types.ts';

export function makeAgent(over: Partial<AgentResponse> = {}): AgentResponse {
  return {
    name: 'gastown.rictus',
    running: false,
    suspended: false,
    state: 'idle',
    available: true,
    rig: 'gascity-cockpit',
    ...over,
  };
}

export function makeCity(over: Partial<CityInfo> = {}): CityInfo {
  return {
    name: 'blackrim-hq',
    path: '/towns/blackrim-hq',
    running: true,
    status: 'running',
    ...over,
  };
}

export function makeHealth(over: Partial<SupervisorHealth> = {}): SupervisorHealth {
  return {
    status: 'ok',
    version: '0.1.0',
    uptime_sec: 3661,
    cities_total: 1,
    cities_running: 1,
    startup: { ready: true },
    ...over,
  };
}

export function makeState(over: Partial<TownStateInput> = {}): TownStateInput {
  return {
    health: makeHealth(),
    cities: [makeCity()],
    agentsByCity: {},
    ...over,
  };
}
