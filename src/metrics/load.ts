// Fetch + derive orchestration for the metrics pane (cockpit-3x7).
//
// The pane is a windowed snapshot, not a live stream: on connect / refresh /
// window change it reads bead-lifecycle history from `/v0` and derives the model
// in one pass. History comes from the city event log — `GET
// /v0/city/{city}/events?since=<window>` — fanned out across `/v0/cities`,
// mirroring how the beads explorer fans out. Per-city failures degrade to a
// `partial` result rather than failing the whole load; only an unreachable
// supervisor (the `/v0/cities` call itself) is a hard error.
//
// Two `/v0` realities shape this (verified against a live supervisor, see
// docs/metrics-over-time.md): the `type` query filter is not honored, so events
// are filtered to bead lifecycle client-side in `normalizeEvent`; and the server
// caps an event page (~1000), so a full page means older in-window events may be
// missing — surfaced as `partial`.
import type { CockpitClient } from '../api/index.ts';
import { runApi } from '../api/index.ts';
import { deriveMetrics, windowById } from './derive.ts';
import { buildRigIndex, normalizeEvent } from './events.ts';
import type { MetricEvent, MetricWindowId, MetricsModel } from './types.ts';

/** How many events to request per city (the server caps below this). */
export const EVENT_FETCH_LIMIT = 5000;

/** A returned page at/above this size is treated as capped → `partial`. */
export const EVENT_CAP_HINT = 1000;

/** Inputs to {@link loadMetrics}. */
export interface LoadOptions {
  windowId: MetricWindowId;
  /** Inclusive end of the window (the derivation's "now"), epoch ms. */
  nowMs: number;
}

/** A successful load — a model, possibly a floor (`partial`). */
export interface MetricsLoadOk {
  ok: true;
  model: MetricsModel;
  partial: boolean;
  fetchedAtMs: number;
}

/** A hard failure — the supervisor could not be reached at all. */
export interface MetricsLoadErr {
  ok: false;
  detail: string;
}

export type MetricsLoad = MetricsLoadOk | MetricsLoadErr;

/** Pull `items[].name` from a `{ items }` list body, skipping blanks. */
function readNames(data: unknown): string[] {
  const out: string[] = [];
  for (const item of readItems(data)) {
    const name = (item as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) out.push(name);
  }
  return out;
}

/** Pull the `items` array from a `{ items }` list body, or `[]`. */
function readItems(data: unknown): unknown[] {
  const items = (data as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

interface CityLoad {
  events: MetricEvent[];
  partial: boolean;
}

/** Fetch one city's rig index + windowed events and normalize them. */
async function loadCity(client: CockpitClient, city: string, since: string): Promise<CityLoad> {
  const [rigsRes, eventsRes] = await Promise.all([
    runApi(() => client.GET('/v0/city/{cityName}/rigs', { params: { path: { cityName: city } } })),
    runApi(() =>
      client.GET('/v0/city/{cityName}/events', {
        params: { path: { cityName: city }, query: { since, limit: EVENT_FETCH_LIMIT } },
      }),
    ),
  ]);

  const rigIndex = buildRigIndex(rigsRes.ok ? readItems(rigsRes.data) : []);
  if (!eventsRes.ok) return { events: [], partial: true };

  const items = readItems(eventsRes.data);
  const events: MetricEvent[] = [];
  for (const raw of items) {
    const ev = normalizeEvent(raw, rigIndex, city);
    if (ev) events.push(ev);
  }
  return { events, partial: items.length >= EVENT_CAP_HINT };
}

/**
 * Load and derive the metrics model for a window. Resolves to a `partial` ok
 * result when any city errored or capped, and to an error only when the
 * supervisor's city list is unreachable.
 */
export async function loadMetrics(client: CockpitClient, opts: LoadOptions): Promise<MetricsLoad> {
  const window = windowById(opts.windowId);
  const since = `${window.hours}h`;

  const citiesRes = await runApi(() => client.GET('/v0/cities'));
  if (!citiesRes.ok) {
    return { ok: false, detail: citiesRes.error.detail ?? citiesRes.error.title };
  }

  const cities = readNames(citiesRes.data);
  const perCity = await Promise.all(cities.map((city) => loadCity(client, city, since)));

  const events: MetricEvent[] = [];
  let partial = false;
  for (const result of perCity) {
    events.push(...result.events);
    if (result.partial) partial = true;
  }

  return {
    ok: true,
    model: deriveMetrics(events, { window, nowMs: opts.nowMs }),
    partial,
    fetchedAtMs: opts.nowMs,
  };
}
