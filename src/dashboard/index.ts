// Public surface of the dashboard embed contract.
//
// This is the reusable, dashboard-AGNOSTIC half of "project the new gascity
// dashboard into a Cockpit webview tab" (PRD Dashboard projection; open design
// decision 2). Everything here is provider-agnostic (no `vscode` import): the
// wire protocol, the CSP-locked shell, URL/theme resolution, and the host-side
// bridge. The thin VS Code panel that drives it lives in `./panel` and is
// imported directly by the extension entry point.
export * from "./protocol";
export * from "./embed";
export * from "./config";
export * from "./bridge";
