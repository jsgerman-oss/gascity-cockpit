// Domain model for the live town-topology graph (cockpit-21l.5).
//
// A `vscode`-free description of the town as a layered graph:
// controller → city (town) → {mayor, rigs} → polecats / witness / refinery.
// `buildTownGraph` derives it from the same `FleetSnapshot` the status panes
// use; `render.ts` turns it into a themeable SVG. Health is expressed with the
// shared {@link StatusKind} so a node here colours the same way it does in the
// Fleet tree. Nothing in this module imports `vscode` (PRD Seam 1).
import type {
  AgentResponse,
  CityInfo,
  SessionResponse,
  StatusKind,
  SupervisorHealth,
} from '../status/index.ts';

/** The layers of the town hierarchy. Drives node shape/aria, not colour. */
export type TownNodeKind = 'controller' | 'city' | 'mayor' | 'rig' | 'agent';

/** A node's health, reusing the status panes' six-way severity enum. */
export type TownHealth = StatusKind;

/** One node in the topology graph. `id` is stable across snapshots so the */
/** webview can diff/animate; insertion order in {@link TownGraph.nodes} is layout order. */
export interface TownNode {
  /** Stable unique id, e.g. `controller`, `city:blackrim-hq`, `rig:blackrim-hq/gascity-cockpit`. */
  id: string;
  kind: TownNodeKind;
  /** Primary display label (city/rig/agent name, or "Controller"). */
  label: string;
  /** Secondary line: agent state + bead, rig member counts, supervisor summary. */
  sublabel: string;
  /** Health severity, mapped to a theme colour by the renderer. */
  health: TownHealth;
  /**
   * For `agent` nodes: the resolved role token (`mayor`, `witness`, `refinery`,
   * `polecat`, `crew`, `deacon`, …) used for the node's role badge. Absent for
   * structural nodes (controller/city/rig).
   */
  role?: string;
}

/** A directed parent→child edge in the hierarchy. */
export interface TownEdge {
  from: string;
  to: string;
}

/** The whole town as a node/edge graph, rooted at the controller. */
export interface TownGraph {
  rootId: string;
  /** Nodes in layout order (controller first, then BFS by layer). */
  nodes: TownNode[];
  edges: TownEdge[];
}

/**
 * The slice of fleet state the topology is derived from — exactly the
 * snapshot-and-lifecycle fields of `FleetStatusState`, so the view can pass its
 * store state straight in. Kept structural (not an import of the status state
 * type) so the core stays decoupled from the store's full shape.
 */
export interface TownStateInput {
  health: SupervisorHealth | null;
  cities: CityInfo[];
  agentsByCity: Record<string, AgentResponse[]>;
  sessionsByCity?: Record<string, SessionResponse[]>;
  /** True between connecting and the first snapshot — shows "connecting…". */
  loading?: boolean;
  /** A fatal-ish error (snapshot failed / API unavailable), or null. */
  lastError?: string | null;
}
