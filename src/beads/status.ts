// Rich status, priority, and rig derivation for beads.
//
// The raw bead carries a coarse `status` ("open" / "in_progress" / "closed" …).
// The explorer wants a richer, actionable status — distinguishing a ready bead
// from a blocked or deferred one — plus stable sort ranks and human labels.
// All of it is pure so it can be unit-tested without an editor.
import type { Bead, BeadRecord, DisplayStatus } from "./types.ts";

/** Sort/grouping order — most actionable first, closed/unknown last. */
const DISPLAY_STATUS_RANK: Record<string, number> = {
  in_progress: 0,
  ready: 1,
  blocked: 2,
  open: 3,
  deferred: 4,
  escalated: 5,
  closed: 6,
};

const DISPLAY_STATUS_LABEL: Record<string, string> = {
  in_progress: "In progress",
  ready: "Ready",
  blocked: "Blocked",
  open: "Open",
  deferred: "Deferred",
  escalated: "Escalated",
  closed: "Closed",
};

export function displayStatusRank(status: DisplayStatus): number {
  return DISPLAY_STATUS_RANK[status] ?? 50;
}

export function displayStatusLabel(status: DisplayStatus): string {
  return DISPLAY_STATUS_LABEL[status] ?? titleCase(status);
}

/**
 * Derive the display status for a bead record.
 *
 * Closed / in-progress / escalated come straight from the raw status. An *open*
 * bead is refined using readiness: `ready === true` → ready, `false` → blocked,
 * `null` (readiness unknown) → plain open. A future-dated `defer_until` on an
 * open bead surfaces as deferred. Any unrecognised raw status is passed through
 * lower-cased so nothing is silently dropped.
 */
export function deriveDisplayStatus(record: BeadRecord, now: Date = new Date()): DisplayStatus {
  const raw = (record.bead.status ?? "").toLowerCase();
  if (raw === "closed") return "closed";
  if (raw === "in_progress" || raw === "in-progress") return "in_progress";
  if (raw === "escalated") return "escalated";

  if (raw === "open" || raw === "") {
    const defer = record.bead.defer_until;
    if (defer) {
      const t = Date.parse(defer);
      if (!Number.isNaN(t) && t > now.getTime()) return "deferred";
    }
    if (record.ready === true) return "ready";
    if (record.ready === false) return "blocked";
    return "open";
  }

  return raw;
}

const PRIORITY_LABEL: Record<number, string> = {
  0: "P0 · critical",
  1: "P1 · high",
  2: "P2 · normal",
  3: "P3 · low",
};

/** Human label for a numeric bead priority (unset → a stable placeholder). */
export function priorityLabel(priority?: number): string {
  if (priority === undefined || priority === null) return "P— · unset";
  return PRIORITY_LABEL[priority] ?? `P${priority}`;
}

/** Sort rank for priority — lower number = higher priority; unset sinks last. */
export function priorityRank(priority?: number): number {
  return priority ?? 99;
}

const UNROUTED = "(unrouted)";
const UNASSIGNED = "(unassigned)";
const UNTYPED = "(untyped)";

/**
 * Best-effort rig for a bead. /v0 beads carry no explicit rig field, so we read
 * the routing metadata the dispatcher stamps: `metadata.rig` if present, else
 * the rig segment of `gc.routed_to` ("rig/role"), else of a "rig/agent"
 * assignee. Falls back to a stable placeholder so grouping never drops a bead.
 */
export function beadRig(bead: Bead): string {
  const meta = bead.metadata ?? {};
  if (meta.rig) return meta.rig;
  const routed = meta["gc.routed_to"];
  if (routed && routed.includes("/")) return routed.split("/")[0];
  const assignee = bead.assignee ?? "";
  if (assignee.includes("/")) return assignee.split("/")[0];
  return UNROUTED;
}

/** Assignee for grouping/filtering; empty assignee → a stable placeholder. */
export function beadAssignee(bead: Bead): string {
  return bead.assignee && bead.assignee.length > 0 ? bead.assignee : UNASSIGNED;
}

/** Issue type for grouping/filtering; missing type → a stable placeholder. */
export function beadType(bead: Bead): string {
  return bead.issue_type && bead.issue_type.length > 0 ? bead.issue_type : UNTYPED;
}

const OPERATIONAL_TYPES = new Set(["message", "molecule", "session", "event"]);
const OPERATIONAL_LABEL_RE = /^(?:gc:nudge|gc:session|gc:order|order-run|order-tracking)\b/;
const OPERATIONAL_TITLE_RE = /^(?:nudge:|order:)/;

/**
 * True for Gas Town's operational machinery — nudge wisps, patrol / order-run
 * wisps, agent-session and mail beads — rather than real work items. These
 * dominate a coordination city's ledger, so the explorer hides them by default
 * (toggleable). Any one signal is enough: a `-wisp-` id, an operational
 * `issue_type`, a `nudge:` / `order:` title, or a gc:nudge / order-run label.
 */
export function isOperationalBead(bead: Bead): boolean {
  if (bead.id.includes("-wisp-")) return true;
  if (bead.issue_type && OPERATIONAL_TYPES.has(bead.issue_type)) return true;
  if (OPERATIONAL_TITLE_RE.test(bead.title ?? "")) return true;
  return (bead.labels ?? []).some((label) => OPERATIONAL_LABEL_RE.test(label));
}

function titleCase(s: string): string {
  if (!s) return s;
  return s
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
