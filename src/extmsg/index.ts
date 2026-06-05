// Public surface of the extmsg participant integration (cockpit-1ll.12).
//
// The editor glue (`extension.ts`) constructs a {@link CallbackServer} and an
// {@link ExtMsgParticipant}, then drives connect/disconnect as the supervisor
// comes and goes — registering VS Code as a first-class, durable extmsg adapter.
// The `vscode`-free /v0 request methods live in `../api` (`extmsg.ts`).
export {
  CallbackServer,
  type CallbackDelivery,
  type CallbackService,
  type CallbackServerOptions,
  type DeliveryHandler,
} from "./callback-server.ts";
export {
  COCKPIT_ADAPTER_CAPABILITIES,
  COCKPIT_ADAPTER_IDENTITY,
  COCKPIT_ADAPTER_NAME,
  COCKPIT_ADAPTER_PROVIDER,
  cockpitAdapterSpec,
  type AdapterIdentity,
} from "./identity.ts";
export {
  ExtMsgParticipant,
  type ExtMsgParticipantDeps,
  type ParticipantEndpoint,
  type RecordedDelivery,
  type RegistrationState,
} from "./participant.ts";
