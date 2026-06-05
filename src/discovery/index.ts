/**
 * Public surface of the API discovery + resilience contract. Dependent Cockpit
 * features (beads explorer, live status panes, chat) import from here.
 */

export type {
  ApiDescriptor,
  ApiEndpoint,
  ApiMode,
  ConnectionState,
  ConnectionStatus,
  DiscoverySource,
  HealthResponse,
  HealthStartup,
  Logger,
  LogLevel,
  Timestamp,
} from './types.ts';
export { DEFAULT_SUPERVISOR_BASE_URL, DESCRIPTOR_SCHEMA_VERSION } from './types.ts';

export {
  buildDescriptor,
  cityDescriptorPath,
  DESCRIPTOR_FILENAME,
  descriptorToEndpoint,
  DescriptorError,
  machineDescriptorPath,
  normalizeBaseUrl,
  parseDescriptor,
  serializeDescriptor,
  type BuildDescriptorOptions,
} from './descriptor.ts';

export {
  HealthParseError,
  ProbeError,
  isHealthy,
  parseHealth,
  probeHealth,
  type FetchLike,
  type ProbeOptions,
} from './health.ts';

export {
  resolveEndpoint,
  type DiscoveryAttempt,
  type DiscoveryInputs,
  type DiscoveryResult,
  type Probe,
  type ReadFile,
} from './discovery.ts';

export {
  backoffDelay,
  ConnectionManager,
  DEFAULT_CONNECTION_OPTIONS,
  type ConnectionDeps,
  type ConnectionOptions,
} from './connection.ts';

export { Emitter, type Disposable, type Listener } from './emitter.ts';
