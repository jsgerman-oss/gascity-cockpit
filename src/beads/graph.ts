// Dependency-graph model + rendering (PRD story 11: "visualize a bead's
// dependency graph"). Pure and `vscode`-free: it turns a `BeadGraphResponse`
// into a layered layout and then into a self-contained, themeable SVG (and a
// Mermaid source for users who prefer it). The webview in `../views` only wraps
// the SVG in a CSP-locked HTML shell and supplies theme colours.
import type { Bead, BeadGraphResponse } from "./types.ts";
import { deriveDisplayStatus, displayStatusLabel } from "./status.ts";

export interface DepEdge {
  from: string;
  to: string;
  kind: string;
}

export interface DepGraph {
  rootId: string;
  /** Node beads keyed by id; insertion order preserved via `order`. */
  nodes: Map<string, Bead>;
  order: string[];
  edges: DepEdge[];
}

export interface GraphLayout {
  /** Node ids bucketed by layer (left → right). */
  levels: string[][];
  position: Map<string, { level: number; lane: number }>;
}

/** Normalise a `/beads/graph` response into a de-duplicated node/edge graph. */
export function buildDependencyGraph(resp: BeadGraphResponse): DepGraph {
  const nodes = new Map<string, Bead>();
  const order: string[] = [];
  const addNode = (bead: Bead | undefined | null): void => {
    if (!bead || nodes.has(bead.id)) return;
    nodes.set(bead.id, bead);
    order.push(bead.id);
  };

  addNode(resp.root);
  for (const bead of resp.beads ?? []) addNode(bead);

  const edges: DepEdge[] = (resp.deps ?? []).map((d) => ({
    from: d.from,
    to: d.to,
    kind: d.kind ?? "",
  }));

  return { rootId: resp.root.id, nodes, order, edges };
}

/**
 * Longest-path layering: every node sits one layer right of its deepest
 * predecessor. Only edges between known nodes count. Any node left inside a
 * dependency cycle is parked one layer past the acyclic frontier so rendering
 * still terminates.
 */
export function layerGraph(graph: DepGraph): GraphLayout {
  const known = new Set(graph.order);
  const edges = graph.edges.filter((e) => known.has(e.from) && known.has(e.to));

  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const id of graph.order) {
    indeg.set(id, 0);
    out.set(id, []);
  }
  for (const e of edges) {
    out.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const id of graph.order) {
    if ((indeg.get(id) ?? 0) === 0) {
      level.set(id, 0);
      queue.push(id);
    }
  }

  let processed = 0;
  while (queue.length > 0) {
    const u = queue.shift()!;
    processed++;
    const lu = level.get(u) ?? 0;
    for (const v of out.get(u)!) {
      level.set(v, Math.max(level.get(v) ?? 0, lu + 1));
      indeg.set(v, (indeg.get(v) ?? 0) - 1);
      if ((indeg.get(v) ?? 0) === 0) queue.push(v);
    }
  }

  // Cycle fallback: anything not drained gets parked past the current frontier.
  if (processed < graph.order.length) {
    const frontier = Math.max(0, ...[...level.values()]) + 1;
    for (const id of graph.order) {
      if (!level.has(id)) level.set(id, frontier);
    }
  }

  const maxLevel = Math.max(0, ...[...level.values()]);
  const levels: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const id of graph.order) levels[level.get(id) ?? 0].push(id);

  const position = new Map<string, { level: number; lane: number }>();
  levels.forEach((ids, lvl) => ids.forEach((id, lane) => position.set(id, { level: lvl, lane })));

  return { levels, position };
}

function statusOf(bead: Bead): string {
  // Graph nodes carry no readiness lookup, so open beads stay "open".
  return deriveDisplayStatus({ city: "", bead, ready: null });
}

/** Mermaid `flowchart` source for the graph (an alternative to the SVG). */
export function renderGraphMermaid(graph: DepGraph): string {
  const lines = ["flowchart LR"];
  for (const id of graph.order) {
    const bead = graph.nodes.get(id)!;
    const label = mermaidLabel(`${id}\n${displayStatusLabel(statusOf(bead))}`);
    lines.push(`  ${nodeKey(id)}["${label}"]`);
  }
  const known = new Set(graph.order);
  for (const e of graph.edges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    const arrow = e.kind ? `-->|${mermaidLabel(e.kind)}|` : "-->";
    lines.push(`  ${nodeKey(e.from)} ${arrow} ${nodeKey(e.to)}`);
  }
  return lines.join("\n");
}

const BOX_W = 184;
const BOX_H = 48;
const GAP_X = 68;
const GAP_Y = 18;
const PAD = 18;

// Styling lives inside the SVG so it renders both standalone and inside the
// webview. Colours reference VS Code theme variables (present in the webview)
// with neutral fallbacks for any other context.
const GRAPH_STYLE = `<style>
  .gc-node rect { fill: var(--vscode-editorWidget-background, #252526); stroke: var(--vscode-widget-border, #454545); stroke-width: 1; }
  .gc-node { cursor: pointer; }
  .gc-node:focus { outline: none; }
  .gc-node:focus-visible rect { stroke: var(--vscode-focusBorder, #007acc); stroke-width: 3; }
  .gc-node-id { fill: var(--vscode-foreground, #ccc); font: 600 12px var(--vscode-font-family, sans-serif); }
  .gc-node-title { fill: var(--vscode-descriptionForeground, #999); font: 11px var(--vscode-font-family, sans-serif); }
  .gc-edge { fill: none; stroke: var(--vscode-editorIndentGuide-activeBackground, #777); stroke-width: 1.5; }
  .gc-arrow-head { fill: var(--vscode-editorIndentGuide-activeBackground, #777); }
  .gc-edge-label { fill: var(--vscode-descriptionForeground, #999); font: 10px var(--vscode-font-family, sans-serif); }
  .gc-root rect { stroke-width: 2.5; stroke: var(--vscode-focusBorder, #007acc); }
  .status-ready rect { stroke: var(--vscode-charts-green, #89d185); }
  .status-in_progress rect { stroke: var(--vscode-charts-blue, #3794ff); }
  .status-blocked rect { stroke: var(--vscode-charts-red, #f14c4c); }
  .status-deferred rect { stroke: var(--vscode-charts-yellow, #cca700); }
  .status-escalated rect { stroke: var(--vscode-charts-orange, #d18616); }
  .status-closed rect { opacity: 0.55; }
</style>`;

/**
 * Render the graph as a standalone SVG string. Colours are driven by CSS
 * variables (with dark-ish fallbacks) so the host webview can map them onto VS
 * Code theme variables; the markup itself carries no script and is CSP-safe.
 */
export function renderGraphSvg(graph: DepGraph, layout: GraphLayout = layerGraph(graph)): string {
  const laneCount = Math.max(1, ...layout.levels.map((l) => l.length));
  const levelCount = Math.max(1, layout.levels.length);
  const width = PAD * 2 + levelCount * BOX_W + (levelCount - 1) * GAP_X;
  const height = PAD * 2 + laneCount * BOX_H + (laneCount - 1) * GAP_Y;

  const x = (level: number): number => PAD + level * (BOX_W + GAP_X);
  const y = (lane: number): number => PAD + lane * (BOX_H + GAP_Y);

  const known = new Set(graph.order);
  const edgeMarkup: string[] = [];
  for (const e of graph.edges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    const a = layout.position.get(e.from)!;
    const b = layout.position.get(e.to)!;
    const x1 = x(a.level) + BOX_W;
    const y1 = y(a.lane) + BOX_H / 2;
    const x2 = x(b.level);
    const y2 = y(b.lane) + BOX_H / 2;
    const dx = Math.max(GAP_X / 2, 24);
    const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    edgeMarkup.push(`<path class="gc-edge" d="${d}" marker-end="url(#gc-arrow)"/>`);
    if (e.kind) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2 - 4;
      edgeMarkup.push(`<text class="gc-edge-label" x="${mx}" y="${my}">${escapeXml(e.kind)}</text>`);
    }
  }

  const nodeMarkup: string[] = [];
  for (const id of graph.order) {
    const bead = graph.nodes.get(id)!;
    const pos = layout.position.get(id)!;
    const nx = x(pos.level);
    const ny = y(pos.lane);
    const status = statusOf(bead);
    const isRoot = id === graph.rootId;
    // Each node is an operable button: focusable (tabindex) and named for screen
    // readers via aria-label (the truncated <text> below is decorative). The
    // webview shell wires Enter/Space + click to open the bead (a11y, Phase 3).
    const ariaLabel = escapeXml(`${id}, ${displayStatusLabel(status)}${bead.title ? `, ${bead.title}` : ""}`);
    nodeMarkup.push(
      `<g class="gc-node status-${cssToken(status)}${isRoot ? " gc-root" : ""}" data-id="${escapeXml(id)}" tabindex="0" role="button" aria-label="${ariaLabel}">` +
        `<rect x="${nx}" y="${ny}" rx="8" ry="8" width="${BOX_W}" height="${BOX_H}"/>` +
        `<text class="gc-node-id" x="${nx + 10}" y="${ny + 19}">${escapeXml(truncate(id, 24))}</text>` +
        `<text class="gc-node-title" x="${nx + 10}" y="${ny + 36}">${escapeXml(truncate(bead.title ?? "", 28))}</text>` +
        `</g>`,
    );
  }

  return [
    // role="group" (not "img"): the node buttons inside must stay reachable by
    // assistive tech — role="img" would collapse the whole graph to one opaque image.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="Bead dependency graph">`,
    GRAPH_STYLE,
    "<defs>",
    '<marker id="gc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">',
    '<path d="M0,0 L10,5 L0,10 z" class="gc-arrow-head"/>',
    "</marker>",
    "</defs>",
    `<g class="gc-edges">${edgeMarkup.join("")}</g>`,
    `<g class="gc-nodes">${nodeMarkup.join("")}</g>`,
    "</svg>",
  ].join("");
}

export interface GraphWebviewHtmlOptions {
  /** The graph body to embed: an SVG from {@link renderGraphSvg}, or an error fragment. */
  body: string;
  /** Per-load nonce; the only script allowed to run (CSP `script-src`). */
  nonce: string;
  /** `webview.cspSource` — the origin styles and images may load from. */
  cspSource: string;
}

/**
 * Wrap a rendered graph {@link renderGraphSvg} body in the CSP-locked webview
 * document shell: theme-driven styling plus a script that opens a bead on click
 * or Enter/Space (the SVG nodes are `role=button` + `tabindex=0`).
 *
 * Pure (string in, string out) so the theming + a11y wiring is unit-tested
 * without a `vscode.Webview` (PRD Testing Decisions, Seam 2); `../views/beadsExplorer.ts`
 * supplies the per-load nonce and `webview.cspSource`.
 */
export function renderGraphWebviewHtml(opts: GraphWebviewHtmlOptions): string {
  const { body, nonce, cspSource } = opts;
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `img-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    "<style>",
    // Declare both schemes so the UA paints native UI — the scrollbars on the
    // .gc-wrap overflow, the canvas background — in the active light/dark/HC
    // variant rather than always-light.
    ":root { color-scheme: light dark; }",
    "body { padding: 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }",
    ".gc-hint { color: var(--vscode-descriptionForeground); margin-bottom: 10px; font-size: 12px; }",
    ".gc-wrap { overflow: auto; }",
    ".gc-error { color: var(--vscode-errorForeground); }",
    "</style></head><body>",
    '<div class="gc-hint">Tab to a bead and press Enter, or click it, to open its detail.</div>',
    body,
    `<script nonce="${nonce}">`,
    "const vscode = acquireVsCodeApi();",
    "function openFrom(target) {",
    "  const g = target.closest('[data-id]');",
    "  if (g) vscode.postMessage({ type: 'open', id: g.getAttribute('data-id') });",
    "}",
    "document.addEventListener('click', (e) => openFrom(e.target));",
    // Keyboard activation: the graph nodes are role=button + tabindex=0, so
    // Enter/Space must trigger the same open as a click (a11y).
    "document.addEventListener('keydown', (e) => {",
    "  if (e.key !== 'Enter' && e.key !== ' ') return;",
    "  const g = e.target.closest('[data-id]');",
    "  if (!g) return;",
    "  e.preventDefault();",
    "  vscode.postMessage({ type: 'open', id: g.getAttribute('data-id') });",
    "});",
    "</script></body></html>",
  ].join("\n");
}

function nodeKey(id: string): string {
  return "n_" + id.replace(/[^A-Za-z0-9]/g, "_");
}

function mermaidLabel(value: string): string {
  return value.replace(/"/g, "'").replace(/\n/g, "<br/>");
}

function cssToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
