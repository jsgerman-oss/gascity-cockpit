// Pure presentation helpers for the cost & tier telemetry panes.
//
// Kept free of `vscode` so the label/description/number logic is unit-testable
// (PRD: behaviour lives behind the testable seam; the tree-view glue stays thin).
// The golden rule here is honesty about absent data: when the supervisor has not
// measured tokens or cost (the current /v0 reality — those fields are "always
// absent"), these render "—" rather than a misleading zero.
import type {
  ModelRollup,
  ScopeRollup,
  TelemetryStreamStatus,
  TelemetryTotals,
  TokenTotals,
} from './types.ts';

/** A small, theme-icon-agnostic status enum used to pick an icon in the glue. */
export type StatusKind = 'ok' | 'busy' | 'idle' | 'warn' | 'error' | 'off';

/** The dash shown wherever the supervisor reported no measurement. */
export const NOT_MEASURED = '—';

/** Format a count compactly: `940`, `1.2k`, `45k`, `1.2M`. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${(k < 10 ? k.toFixed(1) : String(Math.round(k))).replace(/\.0$/, '')}k`;
  }
  const m = n / 1_000_000;
  return `${(m < 10 ? m.toFixed(1) : String(Math.round(m))).replace(/\.0$/, '')}M`;
}

/** Format an accumulated duration in ms as `—`, `350ms`, `4.2s`, `2m 3s`, `1h 4m`. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return NOT_MEASURED;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${(s < 10 ? s.toFixed(1) : String(Math.round(s))).replace(/\.0$/, '')}s`;
  const totalMin = Math.floor(s / 60);
  const secRem = Math.round(s % 60);
  if (totalMin < 60) return `${totalMin}m ${secRem}s`;
  const h = Math.floor(totalMin / 60);
  return `${h}h ${totalMin % 60}m`;
}

/** Total tokens across all four buckets. */
export function totalTokens(t: TokenTotals): number {
  return t.promptIn + t.completionOut + t.cacheCreation + t.cacheRead;
}

/** Format token totals as `—` (nothing measured) or a compact total like `5.0k tok`. */
export function formatTokens(t: TokenTotals): string {
  if (t.measuredOps === 0) return NOT_MEASURED;
  return `${formatCompact(totalTokens(t))} tok`;
}

/** A detailed token breakdown for tooltips, or `—` when nothing was measured. */
export function formatTokenBreakdown(t: TokenTotals): string {
  if (t.measuredOps === 0) return NOT_MEASURED;
  const parts = [`in ${formatCompact(t.promptIn)}`, `out ${formatCompact(t.completionOut)}`];
  if (t.cacheCreation > 0 || t.cacheRead > 0) {
    parts.push(`cache w ${formatCompact(t.cacheCreation)} / r ${formatCompact(t.cacheRead)}`);
  }
  return parts.join(' · ');
}

/** Format a cost in USD as `—` (nothing measured), `$0.00`, `$0.0123`, or `$1.42`. */
export function formatCost(costUsd: number | null, measuredOps: number): string {
  if (costUsd === null || measuredOps === 0) return NOT_MEASURED;
  if (costUsd === 0) return '$0.00';
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

function ops(n: number): string {
  return `${n} op${n === 1 ? '' : 's'}`;
}

// ---- scope (agent / bead) -------------------------------------------------

export function scopeLabel(scope: ScopeRollup): string {
  return scope.key;
}

/**
 * One-line summary for an agent or bead row: operation count, model coverage,
 * failures, duration, and — only when measured — tokens and cost.
 */
export function scopeDescription(scope: ScopeRollup): string {
  const parts = [ops(scope.operations)];
  if (scope.models.length > 1) parts.push(`${scope.models.length} models`);
  else if (scope.models.length === 1) parts.push(scope.models[0]!.model);
  if (scope.failed > 0) parts.push(`${scope.failed} failed`);
  const dur = formatDurationMs(scope.durationMs);
  if (dur !== NOT_MEASURED) parts.push(dur);
  if (scope.tokens.measuredOps > 0) parts.push(formatTokens(scope.tokens));
  const cost = formatCost(scope.costUsd, scope.costMeasuredOps);
  if (cost !== NOT_MEASURED) parts.push(cost);
  return parts.join(' · ');
}

export function scopeStatusKind(scope: ScopeRollup): StatusKind {
  if (scope.operations === 0) return 'idle';
  if (scope.failed > 0 && scope.succeeded === 0) return 'error';
  if (scope.failed > 0) return 'warn';
  return 'ok';
}

// ---- model breakdown ------------------------------------------------------

export function modelLabel(model: ModelRollup): string {
  return model.model;
}

export function modelDescription(model: ModelRollup): string {
  const parts = [ops(model.operations)];
  if (model.providers.length) parts.push(model.providers.join('/'));
  if (model.failed > 0) parts.push(`${model.failed} failed`);
  const dur = formatDurationMs(model.durationMs);
  if (dur !== NOT_MEASURED) parts.push(dur);
  if (model.tokens.measuredOps > 0) parts.push(formatTokens(model.tokens));
  const cost = formatCost(model.costUsd, model.costMeasuredOps);
  if (cost !== NOT_MEASURED) parts.push(cost);
  return parts.join(' · ');
}

export function modelStatusKind(model: ModelRollup): StatusKind {
  if (model.failed > 0 && model.succeeded === 0) return 'error';
  if (model.failed > 0) return 'warn';
  return 'ok';
}

// ---- totals / header ------------------------------------------------------

/** A compact header summary, e.g. `124 ops · 6 agents · 12 beads · 2m 3s`. */
export function totalsSummary(totals: TelemetryTotals): string {
  const parts = [
    ops(totals.operations),
    `${totals.agents} agent${totals.agents === 1 ? '' : 's'}`,
    `${totals.beads} bead${totals.beads === 1 ? '' : 's'}`,
  ];
  const dur = formatDurationMs(totals.durationMs);
  if (dur !== NOT_MEASURED) parts.push(dur);
  if (totals.tokens.measuredOps > 0) parts.push(formatTokens(totals.tokens));
  const cost = formatCost(totals.costUsd, totals.costMeasuredOps);
  if (cost !== NOT_MEASURED) parts.push(cost);
  return parts.join(' · ');
}

// ---- stream status --------------------------------------------------------

export function streamStatusKind(status: TelemetryStreamStatus | null): StatusKind {
  if (!status) return 'off';
  switch (status.state) {
    case 'open':
      return 'ok';
    case 'connecting':
      return 'busy';
    case 'reconnecting':
      return 'warn';
    case 'stopped':
    default:
      return 'off';
  }
}

// ---- accessibility --------------------------------------------------------
//
// A TreeItem's icon-borne severity is invisible to assistive tech, so compose a
// single accessible phrase from the label and its description.

function accessibleName(label: string, description?: string): string {
  return [label, description].filter((part) => part && part.length).join(', ');
}

export function accessibleScopeLabel(scope: ScopeRollup): string {
  return accessibleName(scopeLabel(scope), scopeDescription(scope));
}

export function accessibleModelLabel(model: ModelRollup): string {
  return accessibleName(modelLabel(model), modelDescription(model));
}
