// External-messaging (extmsg) API methods over the typed /v0 client.
//
// extmsg is the supervisor's durable, multi-party conversation fabric: external
// adapters (Slack, a CLI, the VS Code Cockpit) register against a city, bind
// sessions to conversations, exchange inbound/outbound messages, and read a
// shared transcript. This module is the request surface the Cockpit's
// participant integration (cockpit-1ll.12) is built on — registering the editor
// as a first-class adapter and driving the bind / participants / messaging /
// transcript endpoints.
//
// Like the rest of `./api` it is provider-agnostic (no `vscode` import) and
// unit-tested against an OpenAPI-conformant mock /v0 server (PRD Testing
// Decisions, Seam 1). It reuses the shared `runApi` result wrapper and the
// `csrfHeader` mutation header so its shape matches the other domain layers.
import type { CockpitClient } from "./client";
import { csrfHeader } from "./client";
import { runApi, type ApiResult } from "./result";
import type { Schema } from "./types";

// ---------------------------------------------------------------------------
// Domain aliases (over the generated /v0 schemas)
// ---------------------------------------------------------------------------

/** Adapter capabilities — note the PascalCase keys mirror the live schema. */
export type AdapterCapabilities = Schema<"AdapterCapabilities">;
/** `201` body from registering an adapter (`POST .../extmsg/adapters`). */
export type AdapterRegistration = Schema<"ExtMsgAdapterRegisterOutputBody">;
/** One registered adapter as listed by `GET .../extmsg/adapters`. */
export type AdapterInfo = Schema<"ExtmsgAdapterInfo">;
/** Paginated envelope of {@link AdapterInfo}. */
export type AdapterList = Schema<"ListBodyExtmsgAdapterInfo">;
/** A conversation address: `{ scope_id, provider, account_id, conversation_id, kind, … }`. */
export type ConversationRef = Schema<"ConversationRef">;
/** A session↔conversation binding record. */
export type SessionBinding = Schema<"SessionBindingRecord">;
/** Paginated envelope of {@link SessionBinding}. */
export type SessionBindingList = Schema<"ListBodySessionBindingRecord">;
/** Bindings removed by an unbind call. */
export type UnbindResult = Schema<"ExtMsgUnbindBody">;
/** A participant within a conversation group. */
export type GroupParticipant = Schema<"ConversationGroupParticipant">;
/** A conversation group (root conversation, mode, fanout policy, …). */
export type ConversationGroup = Schema<"ConversationGroupRecord">;
/** A normalized inbound message accepted by `POST .../extmsg/inbound`. */
export type ExternalInboundMessage = Schema<"ExternalInboundMessage">;
/** Result of routing an inbound message (binding + transcript entry + target). */
export type InboundResult = Schema<"InboundResult">;
/** Result of publishing an outbound message (receipt + transcript entry). */
export type OutboundResult = Schema<"OutboundResult">;
/** One entry in a conversation transcript. */
export type TranscriptRecord = Schema<"ConversationTranscriptRecord">;
/** Paginated envelope of {@link TranscriptRecord}. */
export type TranscriptList = Schema<"ListBodyConversationTranscriptRecord">;
/** `{ status }` acknowledgement returned by the simple mutation endpoints. */
export type OkResponse = Schema<"OKResponseBody">;
/** The supervisor's list of managed cities. */
export type CitiesList = Schema<"SupervisorCitiesOutputBody">;
/** One managed city: `{ name, path, running, … }`. */
export type CityInfo = Schema<"CityInfo">;

// ---------------------------------------------------------------------------
// Cities (supervisor-wide — extmsg registration fans out across them)
// ---------------------------------------------------------------------------

/** `GET /v0/cities` — every city the supervisor manages, with run status. */
export function listCities(client: CockpitClient): Promise<ApiResult<CitiesList>> {
  return runApi(() => client.GET("/v0/cities"));
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export interface RegisterAdapterParams {
  cityName: string;
  /** Provider key, e.g. `"cockpit"`. */
  provider: string;
  /** Account ID scoping the adapter within the provider. */
  accountId: string;
  /** Display name shown in participant lists. */
  name?: string;
  /**
   * Reachable URL the supervisor POSTs outbound messages to. Required for an
   * adapter to actually receive delivery — the Cockpit serves one locally.
   */
  callbackUrl?: string;
  /** Adapter capabilities (child conversations, attachments, max length). */
  capabilities?: AdapterCapabilities;
}

/**
 * `POST /v0/city/{cityName}/extmsg/adapters` — register an external adapter.
 *
 * The supervisor's adapter registry is in-memory and ephemeral (lost on a
 * controller restart), so the host re-registers on (re)connect to stay durable
 * (see pack `docs/DESIGN.md` fork #2). Returns `{ status, provider, account_id,
 * name }`.
 */
export function registerAdapter(
  client: CockpitClient,
  params: RegisterAdapterParams,
): Promise<ApiResult<AdapterRegistration>> {
  return runApi(() =>
    client.POST("/v0/city/{cityName}/extmsg/adapters", {
      params: { path: { cityName: params.cityName }, header: csrfHeader() },
      body: {
        provider: params.provider,
        account_id: params.accountId,
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.callbackUrl !== undefined ? { callback_url: params.callbackUrl } : {}),
        ...(params.capabilities !== undefined ? { capabilities: params.capabilities } : {}),
      },
    }),
  );
}

/** `GET /v0/city/{cityName}/extmsg/adapters` — list registered adapters. */
export function listAdapters(
  client: CockpitClient,
  params: { cityName: string },
): Promise<ApiResult<AdapterList>> {
  return runApi(() =>
    client.GET("/v0/city/{cityName}/extmsg/adapters", {
      params: { path: { cityName: params.cityName } },
    }),
  );
}

export interface UnregisterAdapterParams {
  cityName: string;
  provider: string;
  accountId: string;
}

/** `DELETE /v0/city/{cityName}/extmsg/adapters` — drop an adapter registration. */
export function unregisterAdapter(
  client: CockpitClient,
  params: UnregisterAdapterParams,
): Promise<ApiResult<OkResponse>> {
  return runApi(() =>
    client.DELETE("/v0/city/{cityName}/extmsg/adapters", {
      params: { path: { cityName: params.cityName }, header: csrfHeader() },
      body: { provider: params.provider, account_id: params.accountId },
    }),
  );
}

// ---------------------------------------------------------------------------
// Session ↔ conversation bindings
// ---------------------------------------------------------------------------

export interface BindParams {
  cityName: string;
  /** Session ID to bind to the conversation. */
  sessionId: string;
  /** Conversation to bind. */
  conversation?: ConversationRef;
  /** Optional binding metadata. */
  metadata?: Record<string, string>;
}

/** `POST /v0/city/{cityName}/extmsg/bind` — bind a session to a conversation. */
export function bindSession(
  client: CockpitClient,
  params: BindParams,
): Promise<ApiResult<SessionBinding>> {
  return runApi(() =>
    client.POST("/v0/city/{cityName}/extmsg/bind", {
      params: { path: { cityName: params.cityName }, header: csrfHeader() },
      body: {
        session_id: params.sessionId,
        ...(params.conversation !== undefined ? { conversation: params.conversation } : {}),
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      },
    }),
  );
}

/** `GET /v0/city/{cityName}/extmsg/bindings` — list bindings, optionally by session. */
export function listBindings(
  client: CockpitClient,
  params: { cityName: string; sessionId?: string },
): Promise<ApiResult<SessionBindingList>> {
  return runApi(() =>
    client.GET("/v0/city/{cityName}/extmsg/bindings", {
      params: {
        path: { cityName: params.cityName },
        query: { ...(params.sessionId !== undefined ? { session_id: params.sessionId } : {}) },
      },
    }),
  );
}

export interface UnbindParams {
  cityName: string;
  sessionId: string;
  /** Conversation to unbind; omit to unbind the session from all conversations. */
  conversation?: ConversationRef;
}

/** `POST /v0/city/{cityName}/extmsg/unbind` — remove session bindings. */
export function unbindSession(
  client: CockpitClient,
  params: UnbindParams,
): Promise<ApiResult<UnbindResult>> {
  return runApi(() =>
    client.POST("/v0/city/{cityName}/extmsg/unbind", {
      params: { path: { cityName: params.cityName }, header: csrfHeader() },
      body: {
        session_id: params.sessionId,
        ...(params.conversation !== undefined ? { conversation: params.conversation } : {}),
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Groups & participants
// ---------------------------------------------------------------------------

export interface EnsureGroupParams {
  cityName: string;
  rootConversation?: ConversationRef;
  /** Group mode (e.g. `"launcher"`). */
  mode?: string;
  /** Default handle for the group. */
  defaultHandle?: string;
  metadata?: Record<string, string>;
}

/** `POST /v0/city/{cityName}/extmsg/groups` — ensure a conversation group exists. */
export function ensureGroup(
  client: CockpitClient,
  params: EnsureGroupParams,
): Promise<ApiResult<ConversationGroup>> {
  return runApi(() =>
    client.POST("/v0/city/{cityName}/extmsg/groups", {
      params: { path: { cityName: params.cityName }, header: csrfHeader() },
      body: {
        ...(params.rootConversation !== undefined ? { root_conversation: params.rootConversation } : {}),
        ...(params.mode !== undefined ? { mode: params.mode } : {}),
        ...(params.defaultHandle !== undefined ? { default_handle: params.defaultHandle } : {}),
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      },
    }),
  );
}

export interface GroupQuery {
  cityName: string;
  scopeId?: string;
  provider?: string;
  accountId?: string;
  conversationId?: string;
  kind?: string;
}

/** `GET /v0/city/{cityName}/extmsg/groups` — look up a group by conversation key. */
export function getGroup(
  client: CockpitClient,
  params: GroupQuery,
): Promise<ApiResult<ConversationGroup>> {
  return runApi(() =>
    client.GET("/v0/city/{cityName}/extmsg/groups", {
      params: {
        path: { cityName: params.cityName },
        query: {
          ...(params.scopeId !== undefined ? { scope_id: params.scopeId } : {}),
          ...(params.provider !== undefined ? { provider: params.provider } : {}),
          ...(params.accountId !== undefined ? { account_id: params.accountId } : {}),
          ...(params.conversationId !== undefined ? { conversation_id: params.conversationId } : {}),
          ...(params.kind !== undefined ? { kind: params.kind } : {}),
        },
      },
    }),
  );
}

export interface UpsertParticipantParams {
  cityName: string;
  groupId: string;
  /** Participant handle (mention target) within the group. */
  handle: string;
  /** Session backing the participant. */
  sessionId: string;
  /** Whether the participant is publicly addressable. */
  public?: boolean;
  metadata?: Record<string, string>;
}

/** `POST /v0/city/{cityName}/extmsg/participants` — add or update a participant. */
export function upsertParticipant(
  client: CockpitClient,
  params: UpsertParticipantParams,
): Promise<ApiResult<GroupParticipant>> {
  return runApi(() =>
    client.POST("/v0/city/{cityName}/extmsg/participants", {
      params: { path: { cityName: params.cityName }, header: csrfHeader() },
      body: {
        group_id: params.groupId,
        handle: params.handle,
        session_id: params.sessionId,
        ...(params.public !== undefined ? { public: params.public } : {}),
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      },
    }),
  );
}

/** `DELETE /v0/city/{cityName}/extmsg/participants` — remove a participant by handle. */
export function removeParticipant(
  client: CockpitClient,
  params: { cityName: string; groupId: string; handle: string },
): Promise<ApiResult<OkResponse>> {
  return runApi(() =>
    client.DELETE("/v0/city/{cityName}/extmsg/participants", {
      params: { path: { cityName: params.cityName }, header: csrfHeader() },
      body: { group_id: params.groupId, handle: params.handle },
    }),
  );
}

// ---------------------------------------------------------------------------
// Messaging (inbound / outbound)
// ---------------------------------------------------------------------------

export interface OutboundParams {
  cityName: string;
  /** Session sending the message. */
  sessionId: string;
  /** Target conversation (omit to use the session's bound conversation). */
  conversation?: ConversationRef;
  /** Message text. */
  text?: string;
  /** Message ID this is a reply to. */
  replyToMessageId?: string;
  /** Idempotency key to dedupe retries. */
  idempotencyKey?: string;
}

/** `POST /v0/city/{cityName}/extmsg/outbound` — publish a message from a session. */
export function postOutbound(
  client: CockpitClient,
  params: OutboundParams,
): Promise<ApiResult<OutboundResult>> {
  return runApi(() =>
    client.POST("/v0/city/{cityName}/extmsg/outbound", {
      params: { path: { cityName: params.cityName }, header: csrfHeader() },
      body: {
        session_id: params.sessionId,
        ...(params.conversation !== undefined ? { conversation: params.conversation } : {}),
        ...(params.text !== undefined ? { text: params.text } : {}),
        ...(params.replyToMessageId !== undefined ? { reply_to_message_id: params.replyToMessageId } : {}),
        ...(params.idempotencyKey !== undefined ? { idempotency_key: params.idempotencyKey } : {}),
      },
    }),
  );
}

export interface InboundParams {
  cityName: string;
  /** A pre-normalized inbound message. */
  message?: ExternalInboundMessage;
  /** Provider name for a raw payload (required when `message` is absent). */
  provider?: string;
  /** Account ID for a raw payload (required when `message` is absent). */
  accountId?: string;
  /** Raw payload bytes (base64 / provider-specific). */
  payload?: string;
}

/** `POST /v0/city/{cityName}/extmsg/inbound` — route an inbound message to a session. */
export function postInbound(
  client: CockpitClient,
  params: InboundParams,
): Promise<ApiResult<InboundResult>> {
  return runApi(() =>
    client.POST("/v0/city/{cityName}/extmsg/inbound", {
      params: { path: { cityName: params.cityName }, header: csrfHeader() },
      body: {
        ...(params.message !== undefined ? { message: params.message } : {}),
        ...(params.provider !== undefined ? { provider: params.provider } : {}),
        ...(params.accountId !== undefined ? { account_id: params.accountId } : {}),
        ...(params.payload !== undefined ? { payload: params.payload } : {}),
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptQuery {
  cityName: string;
  scopeId?: string;
  provider?: string;
  accountId?: string;
  conversationId?: string;
  parentConversationId?: string;
  kind?: string;
  /** Return entries with sequence greater than this (incremental tailing). */
  afterSequence?: number;
  limit?: number;
  /** `"asc"` | `"desc"`. */
  order?: "asc" | "desc";
}

/** `GET /v0/city/{cityName}/extmsg/transcript` — read a conversation transcript. */
export function getTranscript(
  client: CockpitClient,
  params: TranscriptQuery,
): Promise<ApiResult<TranscriptList>> {
  return runApi(() =>
    client.GET("/v0/city/{cityName}/extmsg/transcript", {
      params: {
        path: { cityName: params.cityName },
        query: {
          ...(params.scopeId !== undefined ? { scope_id: params.scopeId } : {}),
          ...(params.provider !== undefined ? { provider: params.provider } : {}),
          ...(params.accountId !== undefined ? { account_id: params.accountId } : {}),
          ...(params.conversationId !== undefined ? { conversation_id: params.conversationId } : {}),
          ...(params.parentConversationId !== undefined
            ? { parent_conversation_id: params.parentConversationId }
            : {}),
          ...(params.kind !== undefined ? { kind: params.kind } : {}),
          ...(params.afterSequence !== undefined ? { after_sequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.order !== undefined ? { order: params.order } : {}),
        },
      },
    }),
  );
}

export interface AckTranscriptParams {
  cityName: string;
  sessionId: string;
  conversation?: ConversationRef;
  /** Acknowledge up to (and including) this sequence number. */
  sequence?: number;
}

/** `POST /v0/city/{cityName}/extmsg/transcript/ack` — mark a transcript read up to a sequence. */
export function ackTranscript(
  client: CockpitClient,
  params: AckTranscriptParams,
): Promise<ApiResult<OkResponse>> {
  return runApi(() =>
    client.POST("/v0/city/{cityName}/extmsg/transcript/ack", {
      params: { path: { cityName: params.cityName }, header: csrfHeader() },
      body: {
        session_id: params.sessionId,
        ...(params.conversation !== undefined ? { conversation: params.conversation } : {}),
        ...(params.sequence !== undefined ? { sequence: params.sequence } : {}),
      },
    }),
  );
}
