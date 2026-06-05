// Render the town-topology graph as a themeable SVG + a CSP-locked webview shell
// (cockpit-21l.5).
//
// Pure (data in, string out) and `vscode`-free, like the beads graph builder
// (`../beads/graph.ts`), so the layout, colour mapping, a11y summary, and the
// live-update wiring are all unit-testable without a `vscode.Webview`. The SVG
// carries only class names; the colours live in the shell `<style>`, which
// cascades onto the SVG once it is injected — so the host can swap just the SVG
// string on each snapshot without re-sending the document.
import type { TownGraph, TownHealth, TownNode } from './types.ts';

export interface TownLayout {
  /** Node ids bucketed by layer (controller = layer 0, left → right). */
  levels: string[][];
  position: Map<string, { level: number; lane: number }>;
}

/**
 * Layer the hierarchy by depth from the controller. Each non-root node has
 * exactly one parent (it is a tree), so depth is `parent.depth + 1`; lanes
 * preserve {@link TownGraph.nodes} order, which the builder already groups by
 * parent so a rig's agents stay contiguous.
 */
export function layoutTown(graph: TownGraph): TownLayout {
  const parent = new Map<string, string>();
  for (const e of graph.edges) parent.set(e.to, e.from);

  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string> = new Set()): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    const p = parent.get(id);
    // Guard against a malformed cyclic parent chain so layout always terminates.
    const d = p === undefined || seen.has(id) ? 0 : depthOf(p, new Set(seen).add(id)) + 1;
    depth.set(id, d);
    return d;
  };
  for (const node of graph.nodes) depthOf(node.id);

  const maxLevel = Math.max(0, ...depth.values());
  const levels: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const node of graph.nodes) levels[depth.get(node.id) ?? 0].push(node.id);

  const position = new Map<string, { level: number; lane: number }>();
  levels.forEach((ids, level) => ids.forEach((id, lane) => position.set(id, { level, lane })));
  return { levels, position };
}

const BOX_W = 212;
const BOX_H = 58;
const GAP_X = 84;
const GAP_Y = 16;
const PAD = 20;

/** Render the topology as a standalone SVG string (styled by the shell's CSS). */
export function renderTownSvg(graph: TownGraph, layout: TownLayout = layoutTown(graph)): string {
  const laneCount = Math.max(1, ...layout.levels.map((l) => l.length));
  const levelCount = Math.max(1, layout.levels.length);
  const width = PAD * 2 + levelCount * BOX_W + (levelCount - 1) * GAP_X;
  const height = PAD * 2 + laneCount * BOX_H + (laneCount - 1) * GAP_Y;

  const x = (level: number): number => PAD + level * (BOX_W + GAP_X);
  const y = (lane: number): number => PAD + lane * (BOX_H + GAP_Y);

  const edgeMarkup: string[] = [];
  for (const e of graph.edges) {
    const a = layout.position.get(e.from);
    const b = layout.position.get(e.to);
    if (!a || !b) continue;
    const x1 = x(a.level) + BOX_W;
    const y1 = y(a.lane) + BOX_H / 2;
    const x2 = x(b.level);
    const y2 = y(b.lane) + BOX_H / 2;
    const dx = Math.max(GAP_X / 2, 28);
    edgeMarkup.push(
      `<path class="gc-edge" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" marker-end="url(#gc-arrow)"/>`,
    );
  }

  const nodeMarkup: string[] = [];
  for (const node of graph.nodes) {
    const pos = layout.position.get(node.id);
    if (!pos) continue;
    nodeMarkup.push(renderNode(node, x(pos.level), y(pos.lane)));
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="Town topology graph">`,
    '<defs>',
    '<marker id="gc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">',
    '<path d="M0,0 L10,5 L0,10 z" class="gc-arrow-head"/>',
    '</marker>',
    '</defs>',
    `<g class="gc-edges">${edgeMarkup.join('')}</g>`,
    `<g class="gc-nodes">${nodeMarkup.join('')}</g>`,
    '</svg>',
  ].join('');
}

function renderNode(node: TownNode, nx: number, ny: number): string {
  const cls = `gc-node gc-kind-${node.kind} health-${node.health}`;
  const badge = badgeText(node);
  const aria = escapeXml(
    [badge, node.label, healthLabel(node.health), node.sublabel].filter(Boolean).join(', '),
  );
  const parts = [
    `<g class="${cls}" role="img" aria-label="${aria}">`,
    `<title>${escapeXml(`${node.label} — ${healthLabel(node.health)}${node.sublabel ? ` · ${node.sublabel}` : ''}`)}</title>`,
    `<rect x="${nx}" y="${ny}" rx="9" ry="9" width="${BOX_W}" height="${BOX_H}"/>`,
    `<circle class="gc-dot" cx="${nx + 15}" cy="${ny + 15}" r="4.5"/>`,
  ];
  if (badge) {
    parts.push(`<text class="gc-badge" x="${nx + 27}" y="${ny + 19}">${escapeXml(badge)}</text>`);
  }
  parts.push(
    `<text class="gc-label" x="${nx + 14}" y="${ny + 39}">${escapeXml(truncate(node.label, 26))}</text>`,
  );
  if (node.sublabel) {
    parts.push(
      `<text class="gc-sublabel" x="${nx + 14}" y="${ny + 52}">${escapeXml(truncate(node.sublabel, 32))}</text>`,
    );
  }
  parts.push('</g>');
  return parts.join('');
}

/** The small uppercase badge above a node's name (its kind, or an agent's role). */
function badgeText(node: TownNode): string {
  if (node.kind === 'controller') return '';
  if (node.kind === 'agent' || node.kind === 'mayor') return (node.role ?? 'agent').toUpperCase();
  return node.kind.toUpperCase();
}

const HEALTH_LABELS: Record<TownHealth, string> = {
  ok: 'ok',
  busy: 'busy',
  idle: 'idle',
  warn: 'warning',
  error: 'error',
  off: 'offline',
};

function healthLabel(health: TownHealth): string {
  return HEALTH_LABELS[health];
}

/**
 * A plain-text, screen-reader-friendly summary of the town: counts plus any
 * nodes carrying a warning/error. Doubles as the webview's `aria-live` payload,
 * so an operator using assistive tech hears what changed when the graph updates.
 */
export function renderTownSummary(graph: TownGraph): string {
  const counts = { city: 0, rig: 0, agent: 0, mayor: 0 };
  const problems: string[] = [];
  for (const node of graph.nodes) {
    if (node.kind in counts) counts[node.kind as keyof typeof counts] += 1;
    if (node.health === 'error' || node.health === 'warn') {
      problems.push(`${node.label} (${healthLabel(node.health)})`);
    }
  }
  const controller = graph.nodes.find((n) => n.id === graph.rootId);
  const agentTotal = counts.agent + counts.mayor;
  const head =
    `Town topology — controller ${controller ? healthLabel(controller.health) : 'unknown'}; ` +
    `${counts.city} ${plural(counts.city, 'city', 'cities')}, ` +
    `${counts.rig} ${plural(counts.rig, 'rig', 'rigs')}, ` +
    `${agentTotal} ${plural(agentTotal, 'agent', 'agents')}.`;
  const tail = problems.length
    ? ` Attention: ${problems.join('; ')}.`
    : ' No warnings or errors.';
  return head + tail;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export interface TownWebviewHtmlOptions {
  /** Per-load nonce; the only script allowed to run (CSP `script-src`). */
  nonce: string;
  /** `webview.cspSource` — the origin styles and images may load from. */
  cspSource: string;
}

/**
 * The CSP-locked webview document shell. It paints a placeholder, then asks the
 * host (via a `ready` message) for the first render and swaps the graph `<svg>`
 * + the `aria-live` summary on each `render` message — so live snapshots update
 * in place without re-sending the whole document (and without losing scroll).
 */
export function renderTownWebviewHtml(opts: TownWebviewHtmlOptions): string {
  const { nonce, cspSource } = opts;
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `img-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  const legend = (['ok', 'busy', 'idle', 'warn', 'error', 'off'] as TownHealth[])
    .map((h) => `<span class="gc-key"><span class="gc-swatch health-${h}"></span>${healthLabel(h)}</span>`)
    .join('');
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<style>',
    // Declare both schemes so native UI (scrollbars, canvas) paints in the
    // active light/dark/HC variant rather than always-light.
    ':root { color-scheme: light dark; }',
    'body { padding: 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }',
    '.gc-hint { color: var(--vscode-descriptionForeground); margin-bottom: 8px; font-size: 12px; }',
    '.gc-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 10px; font-size: 11px; color: var(--vscode-descriptionForeground); }',
    '.gc-key { display: inline-flex; align-items: center; gap: 5px; }',
    '.gc-swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; border: 1px solid var(--vscode-widget-border, #454545); }',
    '.gc-wrap { overflow: auto; }',
    '.gc-error { color: var(--vscode-errorForeground); }',
    // Visually-hidden but available to assistive tech (the live summary).
    '.gc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }',
    // Graph styling — cascades onto the swapped-in SVG.
    '.gc-node rect { fill: var(--vscode-editorWidget-background, #252526); stroke: var(--vscode-widget-border, #454545); stroke-width: 1.25; }',
    '.gc-label { fill: var(--vscode-foreground, #ccc); font: 600 13px var(--vscode-font-family, sans-serif); }',
    '.gc-badge { fill: var(--vscode-descriptionForeground, #999); font: 700 9px var(--vscode-font-family, sans-serif); letter-spacing: 0.06em; }',
    '.gc-sublabel { fill: var(--vscode-descriptionForeground, #999); font: 11px var(--vscode-font-family, sans-serif); }',
    '.gc-edge { fill: none; stroke: var(--vscode-editorIndentGuide-activeBackground, #777); stroke-width: 1.5; }',
    '.gc-arrow-head { fill: var(--vscode-editorIndentGuide-activeBackground, #777); }',
    // Kind accents: the controller reads as the root; cities are emphasised.
    '.gc-kind-controller rect { stroke-width: 2.5; }',
    '.gc-kind-city rect { stroke-width: 2; }',
    // Health: stroke + status dot share the colour. Both are set (not colour
    // alone) so the cue survives high-contrast themes.
    '.health-ok rect { stroke: var(--vscode-charts-green, #89d185); } .health-ok .gc-dot { fill: var(--vscode-charts-green, #89d185); }',
    '.health-busy rect { stroke: var(--vscode-charts-blue, #3794ff); } .health-busy .gc-dot { fill: var(--vscode-charts-blue, #3794ff); }',
    '.health-idle rect { stroke: var(--vscode-charts-foreground, #888); } .health-idle .gc-dot { fill: var(--vscode-charts-foreground, #888); }',
    '.health-warn rect { stroke: var(--vscode-charts-yellow, #cca700); } .health-warn .gc-dot { fill: var(--vscode-charts-yellow, #cca700); }',
    '.health-error rect { stroke: var(--vscode-charts-red, #f14c4c); } .health-error .gc-dot { fill: var(--vscode-charts-red, #f14c4c); }',
    '.health-off rect { stroke: var(--vscode-widget-border, #454545); opacity: 0.7; } .health-off .gc-dot { fill: var(--vscode-widget-border, #6b6b6b); }',
    '</style></head><body>',
    '<div class="gc-hint">Live town topology — controller → city → rigs → agents, coloured by health. Updates as the fleet changes.</div>',
    `<div class="gc-legend">${legend}</div>`,
    '<div class="gc-sr" aria-live="polite" id="gc-sr"></div>',
    '<div class="gc-wrap" id="gc-topology"><p class="gc-hint">Loading town topology…</p></div>',
    `<script nonce="${nonce}">`,
    'const vscode = acquireVsCodeApi();',
    "const graphEl = document.getElementById('gc-topology');",
    "const srEl = document.getElementById('gc-sr');",
    "window.addEventListener('message', (e) => {",
    '  const msg = e.data;',
    "  if (!msg || msg.type !== 'render') return;",
    "  if (typeof msg.svg === 'string') graphEl.innerHTML = msg.svg;",
    "  if (typeof msg.summary === 'string') srEl.textContent = msg.summary;",
    '});',
    // Ask the host for the first paint once the script is live — avoids a race
    // where a snapshot is posted before this listener is attached.
    "vscode.postMessage({ type: 'ready' });",
    '</script></body></html>',
  ].join('\n');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
