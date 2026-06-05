// Public surface of the fleet command-palette domain layer (cockpit-21l.1).
//
// The VS Code glue in `../views/fleetPalette.ts` imports from here. This barrel
// stays free of `vscode` so the parse → run pipeline remains unit-testable in
// plain Node (PRD Seam 1).
export type { FleetQuery, ParsedFleetQuery } from "./types.ts";
export { parseFleetQuery, describeQuery } from "./parse.ts";
export { runFleetQuery, type FleetResultRow, type FleetQueryResult } from "./execute.ts";
