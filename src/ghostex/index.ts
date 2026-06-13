/**
 * Public surface of the Ghostex foundation: the `vscode`-free cores the
 * Ghostex feature (and later beads/session features) are written against.
 * Everything here is unit-tested in plain Node — no `vscode`, no live gxserver.
 */

export {
  DEFAULT_GXSERVER_BASE_URL,
  DEFAULT_TOKEN_PATH,
  GXSERVER_PRODUCT,
  GXSERVER_PROTOCOL_VERSION,
  type GhostexBoardItem,
  type GhostexGlobalSessionRef,
  type GhostexHealth,
  type GhostexLifecycleState,
  type GhostexPresentationGroup,
  type GhostexPresentationProject,
  type GhostexPresentationSession,
  type GhostexPresentationSnapshot,
  type GhostexProject,
  type GhostexProjectId,
  type GhostexRpcError,
  type GhostexRpcSuccess,
  type GhostexServerHealth,
  type GhostexServerId,
  type GhostexSession,
  type GhostexSessionActivity,
  type GhostexSessionId,
  type GhostexSessionKind,
  type GhostexSessionLifecycleResult,
  type GhostexSessionSurface,
  type GhostexTypedOperationResult,
  type GhostexWorktreeEntry,
} from './types.ts';

export {
  GhostexParseError,
  isRecord,
  parseBoardItems,
  parseHealth,
  parseJson,
  parseLifecycleResult,
  parsePresentationSession,
  parsePresentationSnapshot,
  parseProject,
  parseProjectList,
  parseServerHealth,
  parseSession,
  parseSessionList,
  parseSessionText,
  parseTypedOperationResult,
} from './parse.ts';

export {
  CliTransport,
  cliArgsFor,
  GxClient,
  GxClientError,
  RpcTransport,
  type CliTransportOptions,
  type ExecFileLike,
  type FetchLike,
  type GxEndpoint,
  type GxErrorCode,
  type GxParams,
  type GxTransport,
  type RpcTransportOptions,
} from './gxClient.ts';

export {
  discoverGhostex,
  GhostexProbeError,
  probeGhostexHealth,
  probeGhostexServerHealth,
  readiness,
  type GhostexDiscovery,
  type GhostexDiscoveryInputs,
  type GhostexEndpoint,
  type GhostexReadiness,
  type GhostexUnavailableReason,
  type Logger as GhostexLogger,
  type ReadTokenFile,
} from './discovery.ts';

export {
  backoffDelay,
  eventsUrl,
  GhostexEventStream,
  parseGhostexEvent,
  type GhostexDelta,
  type GhostexEvent,
  type GhostexEventStreamOptions,
  type GhostexStreamState,
  type WebSocketFactory,
  type WebSocketLike,
} from './events.ts';
