// Pure, `vscode`-free parsing + attribution for the metrics pane (cockpit-3x7).
//
// `/v0` exposes bead lifecycle as an event log: a `bead.closed` envelope marks a
// merge/close, and a `bead.updated` envelope whose bead carries a refinery
// `rejection_reason` marks a reject. This module turns those raw envelopes into
// the normalized {@link MetricEvent}s the derivation folds, and resolves each to
// a (rig, agent) pair. It is deliberately tolerant — a malformed or irrelevant
// envelope yields `null` rather than throwing — mirroring `parseWorkerOperation`
// in the telemetry feature.
//
// Attribution honesty (see docs/metrics-over-time.md):
//   • rig — taken from the bead-id prefix via the live rig index (cockpit-3x7 →
//     "gascity-cockpit"); this is exact and bead-centric. Falls back to the
//     actor's `<rig>/` scope, then to "(unscoped)".
//   • agent — the recorded implementer (`metadata["gc.session_name"]`), else the
//     assignee, else the lifecycle actor. Closes/rejects are often performed by
//     the refinery or controller, so a system actor can stand in when no
//     implementer was recorded; that limitation is documented upstream.
import type { Attribution, MetricEvent, RigIndex } from './types.ts';

/** Rig label when a bead's prefix matches no known rig. */
export const UNSCOPED_RIG = '(unscoped)';

/** Agent label when no implementer, assignee, or actor was recorded. */
export const UNATTRIBUTED = '(unattributed)';

/** SSE/event type strings this pane cares about. */
export const BEAD_CLOSED_TYPE = 'bead.closed';
export const BEAD_UPDATED_TYPE = 'bead.updated';

/** Issue types that are containers, not countable units of work. */
const CONTAINER_TYPES = new Set(['epic', 'convoy']);

/** Read a non-empty trimmed string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Narrow an unknown to a plain object record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Parse an RFC3339 timestamp to epoch ms, or null when absent/unparseable. */
export function parseTsMs(value: unknown): number | null {
  const s = nonEmptyString(value);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/** The bead-id prefix segment (everything before the first `-`). */
export function beadIdPrefix(beadId: string): string {
  const dash = beadId.indexOf('-');
  return dash === -1 ? beadId : beadId.slice(0, dash);
}

/**
 * Build a prefix→rig-name index from the `/v0` rigs list (loosely typed, since
 * the API is a moving dev build). Rigs without a prefix can't be mapped from a
 * bead id and are simply absent — their beads fall back to actor scope.
 */
export function buildRigIndex(rigs: unknown): RigIndex {
  const byPrefix = new Map<string, string>();
  if (Array.isArray(rigs)) {
    for (const raw of rigs) {
      const rec = asRecord(raw);
      if (!rec) continue;
      const name = nonEmptyString(rec.name);
      const prefix = nonEmptyString(rec.prefix);
      if (name && prefix) byPrefix.set(prefix, name);
    }
  }
  return { byPrefix };
}

/** Resolve a bead to its rig via the prefix index, or {@link UNSCOPED_RIG}. */
export function resolveRig(beadId: string, rigIndex: RigIndex): string {
  return rigIndex.byPrefix.get(beadIdPrefix(beadId)) ?? UNSCOPED_RIG;
}

/** The rig portion of a scoped `<rig>/<agent>` identity, or "" when unscoped. */
export function rigOfAgent(identity: string): string {
  const slash = identity.indexOf('/');
  return slash > 0 ? identity.slice(0, slash) : '';
}

/**
 * Whether a bead is a countable unit of work. Excludes ephemeral molecule
 * tracking beads (`*-wisp-*`, the bulk of event-log churn) and container types
 * (epics, convoys). The `ephemeral` flag would be cleaner but `/v0` leaves it
 * absent on event payloads — that gap is filed upstream.
 */
export function isWorkBead(beadId: string, issueType: string | undefined): boolean {
  if (beadId.includes('-wisp-')) return false;
  if (issueType && CONTAINER_TYPES.has(issueType)) return false;
  return true;
}

/** Resolve the most meaningful agent identity available for a bead event. */
export function resolveAgent(bead: Record<string, unknown>, actor: string | undefined): string {
  const meta = asRecord(bead.metadata);
  const session = meta ? nonEmptyString(meta['gc.session_name']) : undefined;
  if (session) return session;
  const assignee = nonEmptyString(bead.assignee);
  if (assignee) return assignee;
  return nonEmptyString(actor) ?? UNATTRIBUTED;
}

/** Attribute a bead event to a (rig, agent) pair. */
export function attribute(
  bead: Record<string, unknown>,
  actor: string | undefined,
  rigIndex: RigIndex,
): Attribution {
  const beadId = nonEmptyString(bead.id) ?? '';
  const agent = resolveAgent(bead, actor);
  let rig = resolveRig(beadId, rigIndex);
  if (rig === UNSCOPED_RIG) {
    const fromActor = rigOfAgent(agent);
    if (fromActor) rig = fromActor;
  }
  return { rig, agent };
}

/**
 * Normalize one raw `/v0` event envelope into a {@link MetricEvent}, or null when
 * it is not a metric-bearing event (wrong type, malformed, an unfiltered
 * non-reject update, or a non-work bead). `cityHint` supplies the city when the
 * envelope omits it (the city-scoped endpoint returns `city: null`).
 */
export function normalizeEvent(
  envelope: unknown,
  rigIndex: RigIndex,
  cityHint = '',
): MetricEvent | null {
  const env = asRecord(envelope);
  if (!env) return null;

  const type = nonEmptyString(env.type);
  if (type !== BEAD_CLOSED_TYPE && type !== BEAD_UPDATED_TYPE) return null;

  const tsMs = parseTsMs(env.ts);
  if (tsMs === null) return null;

  const payload = asRecord(env.payload);
  const bead = payload ? asRecord(payload.bead) : null;
  if (!bead) return null;

  const beadId = nonEmptyString(bead.id);
  if (!beadId) return null;

  const issueType = nonEmptyString(bead.issue_type);
  if (!isWorkBead(beadId, issueType)) return null;

  const city = nonEmptyString(env.city) ?? nonEmptyString(cityHint) ?? '';
  const actor = nonEmptyString(env.actor);
  const { rig, agent } = attribute(bead, actor, rigIndex);

  if (type === BEAD_CLOSED_TYPE) {
    return {
      kind: 'closed',
      tsMs,
      beadId,
      rig,
      agent,
      city,
      createdAtMs: parseTsMs(bead.created_at),
      rejectionReason: null,
    };
  }

  // bead.updated — only a reject (non-empty rejection_reason) is a metric event.
  const meta = asRecord(bead.metadata);
  const rejectionReason = meta ? nonEmptyString(meta.rejection_reason) : undefined;
  if (!rejectionReason) return null;

  return {
    kind: 'rejected',
    tsMs,
    beadId,
    rig,
    agent,
    city,
    createdAtMs: null,
    rejectionReason,
  };
}
