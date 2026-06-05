// TelemetryStore — the observable model behind the cost & tier telemetry panes.
//
// A plain, `vscode`-free state container (Seam 1), mirroring FleetStatusStore.
// Parsed `worker.operation`s are pushed in via `addOperation`; the tree views
// subscribe to `onDidChange` and re-render from `state`. Operations are rolled up
// per agent and per bead, each broken down by model (the closest proxy the /v0
// contract gives us for "tier"). Token/cost fields are summed only when measured,
// so the UI can distinguish "not instrumented yet" from "genuinely zero".
import { Emitter } from '../discovery/index.ts';
import {
  emptyTokenTotals,
  type ModelRollup,
  type ScopeRollup,
  type TelemetryState,
  type TelemetryStreamStatus,
  type TelemetryTotals,
  type TokenTotals,
  type WorkerOperation,
} from './types.ts';

/** Default ceiling on tracked scopes per dimension; coldest are evicted first. */
export const MAX_SCOPES = 200;

/** Internal mutable scope accumulator; `models` is a map for O(1) upsert. */
interface InternalScope {
  key: string;
  operations: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  tokens: TokenTotals;
  costUsd: number | null;
  costMeasuredOps: number;
  models: Map<string, ModelRollup>;
  lastTs: string;
  lastSeq: number;
}

function newScope(key: string): InternalScope {
  return {
    key,
    operations: 0,
    succeeded: 0,
    failed: 0,
    durationMs: 0,
    tokens: emptyTokenTotals(),
    costUsd: null,
    costMeasuredOps: 0,
    models: new Map(),
    lastTs: '',
    lastSeq: -1,
  };
}

function newModel(model: string): ModelRollup {
  return {
    model,
    providers: [],
    operations: 0,
    succeeded: 0,
    failed: 0,
    durationMs: 0,
    tokens: emptyTokenTotals(),
    costUsd: null,
    costMeasuredOps: 0,
    lastTs: '',
    lastSeq: -1,
  };
}

/** Fold an operation's measured token fields into a running total in place. */
function addTokens(t: TokenTotals, op: WorkerOperation): void {
  let measured = false;
  if (op.promptTokens !== undefined) {
    t.promptIn += op.promptTokens;
    measured = true;
  }
  if (op.completionTokens !== undefined) {
    t.completionOut += op.completionTokens;
    measured = true;
  }
  if (op.cacheCreationTokens !== undefined) {
    t.cacheCreation += op.cacheCreationTokens;
    measured = true;
  }
  if (op.cacheReadTokens !== undefined) {
    t.cacheRead += op.cacheReadTokens;
    measured = true;
  }
  if (measured) t.measuredOps += 1;
}

function copyTokens(t: TokenTotals): TokenTotals {
  return { ...t };
}

function applyToModel(m: ModelRollup, op: WorkerOperation): void {
  m.operations += 1;
  if (op.ok) m.succeeded += 1;
  else m.failed += 1;
  m.durationMs += op.durationMs;
  addTokens(m.tokens, op);
  if (op.costUsd !== undefined) {
    m.costUsd = (m.costUsd ?? 0) + op.costUsd;
    m.costMeasuredOps += 1;
  }
  if (op.provider && !m.providers.includes(op.provider)) {
    m.providers.push(op.provider);
    m.providers.sort();
  }
  if (op.seq >= m.lastSeq) {
    m.lastSeq = op.seq;
    if (op.ts) m.lastTs = op.ts;
  }
}

function applyToScope(scope: InternalScope, op: WorkerOperation): void {
  scope.operations += 1;
  if (op.ok) scope.succeeded += 1;
  else scope.failed += 1;
  scope.durationMs += op.durationMs;
  addTokens(scope.tokens, op);
  if (op.costUsd !== undefined) {
    scope.costUsd = (scope.costUsd ?? 0) + op.costUsd;
    scope.costMeasuredOps += 1;
  }
  let model = scope.models.get(op.model);
  if (!model) {
    model = newModel(op.model);
    scope.models.set(op.model, model);
  }
  applyToModel(model, op);
  if (op.seq >= scope.lastSeq) {
    scope.lastSeq = op.seq;
    if (op.ts) scope.lastTs = op.ts;
  }
}

/** Most-recently-active first; ties broken by key for stable ordering. */
function byActivityDesc(a: { lastSeq: number; key: string }, b: { lastSeq: number; key: string }): number {
  return b.lastSeq - a.lastSeq || a.key.localeCompare(b.key);
}

/** Busiest model first; ties broken by name for stable ordering. */
function byOperationsDesc(a: ModelRollup, b: ModelRollup): number {
  return b.operations - a.operations || a.model.localeCompare(b.model);
}

function toScopeRollup(scope: InternalScope): ScopeRollup {
  const models = [...scope.models.values()]
    .map(
      (m): ModelRollup => ({
        ...m,
        providers: [...m.providers],
        tokens: copyTokens(m.tokens),
      }),
    )
    .sort(byOperationsDesc);
  return {
    key: scope.key,
    operations: scope.operations,
    succeeded: scope.succeeded,
    failed: scope.failed,
    durationMs: scope.durationMs,
    tokens: copyTokens(scope.tokens),
    costUsd: scope.costUsd,
    costMeasuredOps: scope.costMeasuredOps,
    models,
    lastTs: scope.lastTs,
    lastSeq: scope.lastSeq,
  };
}

export class TelemetryStore {
  private agents = new Map<string, InternalScope>();
  private beads = new Map<string, InternalScope>();
  private readonly grand: TelemetryTotals = emptyTotals();
  private stream: TelemetryStreamStatus | null = null;
  private evicted = false;
  /** Highest envelope seq applied; drops replays after a reconnect. */
  private maxSeq = -1;

  private readonly emitter = new Emitter<TelemetryState>();
  private _state: TelemetryState = this.build();

  constructor(private readonly maxScopes: number = MAX_SCOPES) {}

  /** Subscribe to any state change. Fires after every mutation. */
  readonly onDidChange = this.emitter.event;

  /** Current immutable-by-convention state. Treat as read-only. */
  get state(): TelemetryState {
    return this._state;
  }

  /**
   * Fold one parsed operation into the rollups. Ignores operations whose seq was
   * already applied (a reconnect replayed them), keeping counts exact.
   */
  addOperation(op: WorkerOperation): void {
    if (op.seq <= this.maxSeq) return;
    this.maxSeq = op.seq;

    this.upsert(this.agents, op.agent, op);
    this.upsert(this.beads, op.bead, op);

    this.grand.operations += 1;
    if (op.ok) this.grand.succeeded += 1;
    else this.grand.failed += 1;
    this.grand.durationMs += op.durationMs;
    addTokens(this.grand.tokens, op);
    if (op.costUsd !== undefined) {
      this.grand.costUsd = (this.grand.costUsd ?? 0) + op.costUsd;
      this.grand.costMeasuredOps += 1;
    }

    this.refresh();
  }

  /** Replace the SSE subscription status. */
  setStreamStatus(status: TelemetryStreamStatus): void {
    this.stream = status;
    this.refresh();
  }

  /** Zero the rollups (keeping the dedup watermark so replays stay dropped). */
  clear(): void {
    this.agents = new Map();
    this.beads = new Map();
    Object.assign(this.grand, emptyTotals());
    this.evicted = false;
    this.refresh();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private upsert(map: Map<string, InternalScope>, key: string, op: WorkerOperation): void {
    let scope = map.get(key);
    const isNew = scope === undefined;
    if (!scope) {
      scope = newScope(key);
      map.set(key, scope);
    }
    // Apply first so a freshly-created scope carries this op's seq (the highest
    // seen) before eviction runs — otherwise it would look coldest and evict
    // itself. Eviction then drops the genuinely least-recently-active scope.
    applyToScope(scope, op);
    if (isNew) this.evictColdest(map);
  }

  /** Drop the least-recently-active scope when a map exceeds the cap. */
  private evictColdest(map: Map<string, InternalScope>): void {
    if (map.size <= this.maxScopes) return;
    let coldestKey: string | null = null;
    let coldestSeq = Infinity;
    for (const [key, scope] of map) {
      if (scope.lastSeq < coldestSeq) {
        coldestSeq = scope.lastSeq;
        coldestKey = key;
      }
    }
    if (coldestKey !== null) {
      map.delete(coldestKey);
      this.evicted = true;
    }
  }

  private refresh(): void {
    this._state = this.build();
    this.emitter.fire(this._state);
  }

  private build(): TelemetryState {
    const agents = [...this.agents.values()].map(toScopeRollup).sort(byActivityDesc);
    const beads = [...this.beads.values()].map(toScopeRollup).sort(byActivityDesc);
    const totals: TelemetryTotals = {
      ...this.grand,
      tokens: copyTokens(this.grand.tokens),
      agents: this.agents.size,
      beads: this.beads.size,
    };
    return {
      agents,
      beads,
      totals,
      stream: this.stream,
      evicted: this.evicted,
      anyCostMeasured: this.grand.tokens.measuredOps > 0 || this.grand.costMeasuredOps > 0,
    };
  }
}

function emptyTotals(): TelemetryTotals {
  return {
    operations: 0,
    succeeded: 0,
    failed: 0,
    durationMs: 0,
    tokens: emptyTokenTotals(),
    costUsd: null,
    costMeasuredOps: 0,
    agents: 0,
    beads: 0,
  };
}
