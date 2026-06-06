// Domain model for the Beads explorer (PRD user stories 7–11).
//
// This whole `beads/` directory is provider-agnostic — no `vscode` imports — so
// it is the Seam-1 layer the explorer is tested through (PRD Testing Decisions).
// The VS Code-bound tree/detail/graph glue lives in `../views` and is kept thin.
import type { Schema } from "../api/types.ts";

/** A single bead as returned by the /v0 contract. */
export type Bead = Schema<"Bead">;
/** A dependency edge attached to a bead (`issue_id` depends on `depends_on_id`). */
export type Dep = Schema<"Dep">;
/** One city as advertised by `GET /v0/cities`. */
export type CityInfo = Schema<"CityInfo">;
/** `GET /v0/city/{city}/beads` / `…/beads/ready` envelope. */
export type ListBodyBead = Schema<"ListBodyBead">;
/** `GET /v0/city/{city}/beads/graph/{root}` body. */
export type BeadGraphResponse = Schema<"BeadGraphResponse">;
/** A directed edge in a bead dependency graph. */
export type WorkflowDep = Schema<"WorkflowDepResponse">;

/**
 * A bead paired with the city it came from and its readiness. `ready` is `null`
 * when the `/beads/ready` lookup was unavailable, so the UI can avoid implying a
 * bead is "blocked" when it simply could not be checked.
 */
export interface BeadRecord {
  city: string;
  bead: Bead;
  ready: boolean | null;
}

/**
 * Display-level status, richer than the raw bead status. `ready`/`blocked`/
 * `deferred` are derived for open beads; the `(string & {})` arm preserves any
 * future raw status the server might add without losing type help for the known
 * set.
 */
export type DisplayStatus =
  | "in_progress"
  | "ready"
  | "blocked"
  | "open"
  | "deferred"
  | "escalated"
  | "closed"
  | (string & {});

/** Dimensions the explorer can group/filter by (PRD story 8). */
export type GroupKey = "status" | "rig" | "assignee" | "type" | "priority";

export const GROUP_KEYS: readonly GroupKey[] = ["status", "rig", "assignee", "type", "priority"];

/** Active filter predicate set. All present fields must match (logical AND). */
export interface BeadFilters {
  /** Case-insensitive substring matched against `id` and `title`. */
  text?: string;
  /** Keep only beads whose derived display status is in this set. */
  status?: DisplayStatus[];
  /** Exact rig (see `beadRig`). */
  rig?: string;
  /** Exact assignee; the empty string matches unassigned beads. */
  assignee?: string;
  /** Exact `issue_type`. */
  type?: string;
  /** Exact numeric priority. */
  priority?: number;
  /** When false, closed beads are hidden unless `status` explicitly lists them. */
  includeClosed: boolean;
  /**
   * Unless explicitly `false`, operational machinery (nudge / order / patrol
   * wisps, agent sessions, mail) is hidden — see `isOperationalBead`. Defaults
   * to hidden so the explorer shows real work, not Gas Town's plumbing.
   */
  hideOperational?: boolean;
}

export const DEFAULT_FILTERS: BeadFilters = { includeClosed: false, hideOperational: true };

/** Beads for one city plus the partial/error context of fetching them. */
export interface CityRecords {
  city: string;
  running: boolean;
  records: BeadRecord[];
  /** True when the server truncated the result set (`ListBodyBead.partial`). */
  partial: boolean;
  /** Set when this city could not be loaded; `records` is then empty. */
  error?: string;
}

/** The full multi-city dataset backing one explorer refresh. */
export interface ExplorerData {
  cities: CityRecords[];
}

// --- Tree node model (a pure structure the VS Code provider walks) ----------

export interface CityNode {
  kind: "city";
  id: string;
  city: string;
  running: boolean;
  error?: string;
  partial: boolean;
  count: number;
  children: Array<GroupNode | MessageNode>;
}

export interface GroupNode {
  kind: "group";
  id: string;
  city: string;
  groupBy: GroupKey;
  key: string;
  label: string;
  rank: number;
  count: number;
  children: BeadLeaf[];
}

export interface BeadLeaf {
  kind: "bead";
  id: string;
  city: string;
  beadId: string;
  record: BeadRecord;
  displayStatus: DisplayStatus;
}

/** A non-bead informational row (errors, empty states, "city stopped"). */
export interface MessageNode {
  kind: "message";
  id: string;
  label: string;
  detail?: string;
  icon?: string;
  /** `ThemeColor` id tinting the icon (e.g. the error red); see `../ui/view-state`. */
  iconColor?: string;
}

export type BeadTreeNode = CityNode | GroupNode | BeadLeaf | MessageNode;
