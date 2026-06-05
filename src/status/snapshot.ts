// Fleet snapshot fetcher over the typed /v0 client.
//
// Produces a {@link FleetSnapshot} from `GET /health`, `GET /v0/cities`, and
// per-running-city `GET .../agents` + `.../sessions`. Resilient by design: any
// single call failing is recorded in `partialErrors` rather than aborting the
// whole snapshot, so one wedged city never blanks the panes. Provider-agnostic
// (Seam 1) — tested against a mock /v0 server.
import { normalizeError, type CockpitClient } from '../api/index.ts';
import type {
  AgentResponse,
  CityInfo,
  FleetSnapshot,
  SessionResponse,
  SupervisorHealth,
} from './types.ts';

export interface FetchSnapshotOptions {
  /** Aborts all in-flight requests when triggered. */
  signal?: AbortSignal;
}

export async function fetchFleetSnapshot(
  client: CockpitClient,
  options: FetchSnapshotOptions = {},
): Promise<FleetSnapshot> {
  const { signal } = options;
  const partialErrors: string[] = [];

  const health = await fetchHealth(client, signal, partialErrors);
  const cities = await fetchCities(client, signal, partialErrors);

  const agentsByCity: Record<string, AgentResponse[]> = {};
  const sessionsByCity: Record<string, SessionResponse[]> = {};

  // Only running cities can answer agent/session queries; skip stopped ones.
  const running = cities.filter((city) => city.running);
  await Promise.all(
    running.map(async (city) => {
      const [agents, sessions] = await Promise.all([
        fetchAgents(client, city.name, signal, partialErrors),
        fetchSessions(client, city.name, signal, partialErrors),
      ]);
      agentsByCity[city.name] = agents;
      sessionsByCity[city.name] = sessions;
    }),
  );

  return { health, cities, agentsByCity, sessionsByCity, partialErrors };
}

async function fetchHealth(
  client: CockpitClient,
  signal: AbortSignal | undefined,
  errors: string[],
): Promise<SupervisorHealth | null> {
  try {
    const { data, error, response } = await client.GET('/health', { signal });
    if (data) return data;
    errors.push(`health: ${normalizeError(error, response).title}`);
  } catch (err) {
    errors.push(`health: ${normalizeError(err).title}`);
  }
  return null;
}

async function fetchCities(
  client: CockpitClient,
  signal: AbortSignal | undefined,
  errors: string[],
): Promise<CityInfo[]> {
  try {
    const { data, error, response } = await client.GET('/v0/cities', { signal });
    if (data) return data.items ?? [];
    errors.push(`cities: ${normalizeError(error, response).title}`);
  } catch (err) {
    errors.push(`cities: ${normalizeError(err).title}`);
  }
  return [];
}

async function fetchAgents(
  client: CockpitClient,
  cityName: string,
  signal: AbortSignal | undefined,
  errors: string[],
): Promise<AgentResponse[]> {
  try {
    const { data, error, response } = await client.GET('/v0/city/{cityName}/agents', {
      params: { path: { cityName } },
      signal,
    });
    if (data) return data.items ?? [];
    errors.push(`agents[${cityName}]: ${normalizeError(error, response).title}`);
  } catch (err) {
    errors.push(`agents[${cityName}]: ${normalizeError(err).title}`);
  }
  return [];
}

async function fetchSessions(
  client: CockpitClient,
  cityName: string,
  signal: AbortSignal | undefined,
  errors: string[],
): Promise<SessionResponse[]> {
  try {
    const { data, error, response } = await client.GET('/v0/city/{cityName}/sessions', {
      params: { path: { cityName } },
      signal,
    });
    if (data) return data.items ?? [];
    errors.push(`sessions[${cityName}]: ${normalizeError(error, response).title}`);
  } catch (err) {
    errors.push(`sessions[${cityName}]: ${normalizeError(err).title}`);
  }
  return [];
}
