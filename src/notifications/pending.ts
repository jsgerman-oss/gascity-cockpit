// Aggregate the pending interactions blocking agents across the whole fleet.
//
// Approvals are not on the event feed — they are exposed per city by
// `GET /v0/city/{city}/pending` (see `../api/approvals`). To notify on them we
// enumerate running cities and union their pending interactions into one flat
// list the engine can diff. Resilient by design: a city that fails to enumerate
// is skipped rather than aborting the sweep, so one wedged city never hides a
// blocked agent elsewhere (PRD story 26 — "nothing blocks unseen"). `vscode`-free
// and tested against a mock /v0 server.
import { listCityPending, type CockpitClient } from '../api/index.ts';

/** One agent awaiting a human decision, tagged with the city it lives in. */
export interface PendingApproval {
  /** City the session belongs to. */
  readonly city: string;
  /** Session awaiting the decision. */
  readonly sessionId: string;
  /** Interaction request id — echoed on respond to avoid answering a stale prompt. */
  readonly requestId: string;
  /** Interaction kind, e.g. `tool-approval` or `prompt-for-input`. */
  readonly kind: string;
}

/** Stable dedupe key for a pending approval. */
export function approvalKey(a: PendingApproval): string {
  return `appr:${a.city}/${a.sessionId}/${a.requestId}`;
}

/**
 * List every pending interaction across all running cities. Stopped cities
 * cannot answer the query and are skipped; a per-city failure is swallowed (the
 * sweep is best-effort) so the remaining cities still report. Returns a flat,
 * city-tagged list.
 */
export async function fetchPendingApprovals(
  client: CockpitClient,
  options: { signal?: AbortSignal } = {},
): Promise<PendingApproval[]> {
  const cities = await fetchRunningCities(client, options.signal);

  const perCity = await Promise.all(
    cities.map(async (city): Promise<PendingApproval[]> => {
      const res = await listCityPending(client, city);
      if (!res.ok) return [];
      return res.data.entries.map((entry) => ({
        city,
        sessionId: entry.session_id,
        requestId: entry.request_id,
        kind: entry.kind,
      }));
    }),
  );

  return perCity.flat();
}

/** Names of running cities, or [] when the listing fails. */
async function fetchRunningCities(
  client: CockpitClient,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  try {
    const { data } = await client.GET('/v0/cities', signal ? { signal } : {});
    return (data?.items ?? []).filter((c) => c.running).map((c) => c.name);
  } catch {
    return [];
  }
}
