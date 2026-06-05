// Public surface of the formula preview/runs domain (PRD stories 30–31).
//
// The VS Code glue in `../views/formulaFlows.ts` imports from here. This barrel
// stays free of `vscode` so the formatting/run-state logic remains unit-testable.
// The typed formula client lives in `../api/formulas` (Seam 1).
export {
  formatFormulaDetailMarkdown,
  formatRunsMarkdown,
  relativeTime,
  runState,
  runStateLabel,
  sortRunsNewestFirst,
  type RunState,
} from "./format.ts";
