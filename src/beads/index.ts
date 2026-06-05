// Public surface of the Beads explorer domain layer (PRD stories 7–11).
//
// The VS Code glue in `../views` imports from here. This barrel stays free of
// `vscode` so the whole layer remains unit-testable against a mock /v0 server.
export type {
  Bead,
  BeadFilters,
  BeadGraphResponse,
  BeadLeaf,
  BeadRecord,
  BeadTreeNode,
  CityInfo,
  CityNode,
  CityRecords,
  Dep,
  DisplayStatus,
  ExplorerData,
  GroupKey,
  GroupNode,
  ListBodyBead,
  MessageNode,
  WorkflowDep,
} from "./types.ts";
export { DEFAULT_FILTERS, GROUP_KEYS } from "./types.ts";

export {
  beadAssignee,
  beadRig,
  beadType,
  deriveDisplayStatus,
  displayStatusLabel,
  displayStatusRank,
  priorityLabel,
  priorityRank,
} from "./status.ts";

export {
  buildBeadTree,
  filterRecords,
  groupRecords,
  sortRecords,
  type BeadViewSpec,
} from "./filter.ts";

export { formatBeadDetailMarkdown } from "./detail.ts";

export { accessibleBeadNodeLabel } from "./a11y.ts";

export {
  buildDependencyGraph,
  layerGraph,
  renderGraphMermaid,
  renderGraphSvg,
  type DepEdge,
  type DepGraph,
  type GraphLayout,
} from "./graph.ts";

export {
  BeadsApiError,
  BeadsRepository,
  type BeadsRepositoryDeps,
  type LoadOptions,
} from "./repository.ts";
