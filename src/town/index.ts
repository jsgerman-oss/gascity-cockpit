// Public surface of the town-topology core (cockpit-21l.5).
//
// The editor glue (`../views/townTopology.ts`) imports from here; nothing in
// this barrel imports `vscode`, so the whole topology core stays in the Seam-1
// test layer alongside the beads graph and status model.
export type {
  TownEdge,
  TownGraph,
  TownHealth,
  TownNode,
  TownNodeKind,
  TownStateInput,
} from './types.ts';

export { aggregateHealth, agentRole, buildTownGraph, CONTROLLER_ID } from './topology.ts';

export {
  layoutTown,
  renderTownSummary,
  renderTownSvg,
  renderTownWebviewHtml,
  type TownLayout,
  type TownWebviewHtmlOptions,
} from './render.ts';
