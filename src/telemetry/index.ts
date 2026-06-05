// Public surface of the cost & tier telemetry feature (cockpit-21l.3).
//
// The editor glue (src/views/telemetry.ts) imports from here; nothing in this
// barrel imports `vscode`, so the whole telemetry core stays in the Seam-1 test
// layer. See docs/cost-tier-telemetry.md for the /v0 contract it binds to and
// the upstream gap (model-advisor tier decisions, token/cost population).
export type {
  ModelRollup,
  ScopeRollup,
  TelemetryState,
  TelemetryStreamState,
  TelemetryStreamStatus,
  TelemetryTotals,
  TokenTotals,
  WorkerOperation,
  WorkerOperationPayload,
} from './types.ts';
export { NO_BEAD, UNKNOWN_AGENT, UNKNOWN_MODEL, emptyTokenTotals } from './types.ts';

export {
  DEFAULT_TELEMETRY_STREAM_OPTIONS,
  deriveOk,
  parseWorkerOperation,
  TelemetryStream,
  WORKER_OPERATION_TYPE,
  type OpenStream,
  type Sleep,
  type TelemetryStreamDeps,
  type TelemetryStreamOptions,
} from './events.ts';

export { MAX_SCOPES, TelemetryStore } from './store.ts';

export { LiveTelemetry, type LiveTelemetryDeps, type TelemetryEndpoint } from './live.ts';

export {
  accessibleModelLabel,
  accessibleScopeLabel,
  formatCompact,
  formatCost,
  formatDurationMs,
  formatTokenBreakdown,
  formatTokens,
  modelDescription,
  modelLabel,
  modelStatusKind,
  NOT_MEASURED,
  scopeDescription,
  scopeLabel,
  scopeStatusKind,
  streamStatusKind,
  totalsSummary,
  totalTokens,
  type StatusKind,
} from './format.ts';
