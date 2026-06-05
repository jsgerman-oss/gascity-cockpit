// Tool-approval cockpit domain layer (PRD user stories 23–26).
//
// When an agent pauses for a tool-approval or asks the operator a question
// (prompt-for-input), the supervisor exposes it over /v0; this module is the
// typed, normalised seam the Cockpit UI drives:
//
//   - listCityPending   GET  /v0/city/{city}/pending              (all sessions)
//   - getSessionPending GET  /v0/city/{city}/session/{id}/pending (one session)
//   - respond           POST /v0/city/{city}/session/{id}/respond
//   - setPermissionMode POST /v0/city/{city}/session/{id}/permission-mode
//
// It is provider-agnostic (no `vscode` import) so it is unit-tested against an
// OpenAPI-conformant mock /v0 server (PRD Testing Decisions, Seam 1). Mutations
// carry the anti-CSRF header via `csrfHeader()`; required fields are validated
// client-side so the UI gets immediate feedback instead of a round-trip 4xx.
import type { CockpitClient } from "./client";
import { csrfHeader } from "./client";
import { runApi, validationError, type ApiResult } from "./result";
import type {
  CityPendingEntry,
  PendingInteraction,
  SessionDetail,
  SessionRespondResult,
} from "./types";

/** A tool-approval prompt: the agent wants to run a tool and needs allow/deny. */
export const PENDING_KIND_TOOL_APPROVAL = "tool-approval";
/** A prompt-for-input: the agent asked the operator a question and wants text. */
export const PENDING_KIND_PROMPT_FOR_INPUT = "prompt-for-input";

/** Conventional "allow" action for a tool-approval (see `respond`). */
export const RESPOND_ACTION_ALLOW = "allow";
/** Conventional "deny" action for a tool-approval (see `respond`). */
export const RESPOND_ACTION_DENY = "deny";

/** True when the interaction is an agent asking to run a tool. */
export function isToolApproval(it: { kind: string }): boolean {
  return it.kind === PENDING_KIND_TOOL_APPROVAL;
}

/** True when the interaction is an agent asking the operator a question. */
export function isPromptForInput(it: { kind: string }): boolean {
  return it.kind === PENDING_KIND_PROMPT_FOR_INPUT;
}

/** City-wide aggregation of pending interactions across every session. */
export interface CityPending {
  /** One entry per session awaiting a human decision. */
  entries: CityPendingEntry[];
  /** True when one or more backends failed; `entries` may be incomplete. */
  partial: boolean;
  /** Human-readable errors from backends that failed during aggregation. */
  partialErrors: string[];
  /** Total number of pending interactions the server reported. */
  total: number;
}

/** The pending interaction (if any) for a single session. */
export interface SessionPending {
  /** The interaction awaiting a decision, or `null` when the session is free. */
  pending: PendingInteraction | null;
  /** False when this provider/session cannot report pending interactions. */
  supported: boolean;
}

/** Operator's response to a pending interaction. */
export interface RespondInput {
  /**
   * The chosen action. For a tool-approval this is one of the interaction's
   * `options` (commonly `RESPOND_ACTION_ALLOW` / `RESPOND_ACTION_DENY`); for a
   * prompt-for-input it is the provider's submit action. Required, non-empty.
   */
  action: string;
  /** Free-text reply, primarily for prompt-for-input. */
  text?: string;
  /**
   * Echo the pending interaction's `request_id` so a stale prompt (already
   * resolved or superseded) is not answered by mistake.
   */
  requestId?: string;
  /** Optional provider-specific response metadata. */
  metadata?: Record<string, string>;
}

/**
 * Aggregate pending interactions across every session in a city (PRD story 26 —
 * "nothing blocks unseen"). Surfaces `partial`/`partialErrors` so a failed
 * backend cannot silently hide a blocked agent.
 */
export async function listCityPending(
  client: CockpitClient,
  cityName: string,
): Promise<ApiResult<CityPending>> {
  const res = await runApi(() =>
    client.GET("/v0/city/{cityName}/pending", { params: { path: { cityName } } }),
  );
  if (!res.ok) return res;
  const body = res.data;
  return {
    ok: true,
    requestId: res.requestId,
    data: {
      entries: body.items ?? [],
      partial: body.partial ?? false,
      partialErrors: body.partial_errors ?? [],
      total: body.total,
    },
  };
}

/** Fetch the pending interaction (if any) blocking a single session. */
export async function getSessionPending(
  client: CockpitClient,
  cityName: string,
  sessionId: string,
): Promise<ApiResult<SessionPending>> {
  const res = await runApi(() =>
    client.GET("/v0/city/{cityName}/session/{id}/pending", {
      params: { path: { cityName, id: sessionId } },
    }),
  );
  if (!res.ok) return res;
  return {
    ok: true,
    requestId: res.requestId,
    data: { pending: res.data.pending ?? null, supported: res.data.supported },
  };
}

/**
 * Respond to a session's pending interaction — approve/deny a tool-approval or
 * submit an answer to a prompt-for-input. `action` is required; the supervisor
 * rejects an empty one, so we guard it here for an immediate error.
 */
export async function respond(
  client: CockpitClient,
  cityName: string,
  sessionId: string,
  input: RespondInput,
): Promise<ApiResult<SessionRespondResult>> {
  const action = input.action?.trim();
  if (!action) {
    return validationError("A response action is required (e.g. allow or deny).");
  }
  return runApi(() =>
    client.POST("/v0/city/{cityName}/session/{id}/respond", {
      params: { path: { cityName, id: sessionId }, header: csrfHeader() },
      body: {
        action,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.requestId !== undefined ? { request_id: input.requestId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    }),
  );
}

/** Options forwarded by `approve` / `deny` to {@link respond}. */
export interface ApproveOptions {
  /** Echo the pending interaction's `request_id` to avoid a stale answer. */
  requestId?: string;
  /** Optional provider-specific response metadata. */
  metadata?: Record<string, string>;
  /**
   * Override the action token. Use when the provider's allow/deny vocabulary is
   * not the conventional `RESPOND_ACTION_ALLOW`/`RESPOND_ACTION_DENY` (read it
   * from the interaction's `options`).
   */
  action?: string;
}

/**
 * Approve a tool-approval. Convenience over {@link respond} for the common
 * allow case; when the interaction lists explicit `options`, pass the chosen
 * one via `action` (or call `respond` directly).
 */
export function approve(
  client: CockpitClient,
  cityName: string,
  sessionId: string,
  opts: ApproveOptions = {},
): Promise<ApiResult<SessionRespondResult>> {
  return respond(client, cityName, sessionId, {
    action: opts.action ?? RESPOND_ACTION_ALLOW,
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  });
}

/** Deny a tool-approval. Convenience over {@link respond} for the common case. */
export function deny(
  client: CockpitClient,
  cityName: string,
  sessionId: string,
  opts: ApproveOptions = {},
): Promise<ApiResult<SessionRespondResult>> {
  return respond(client, cityName, sessionId, {
    action: opts.action ?? RESPOND_ACTION_DENY,
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  });
}

/**
 * Set a session's permission mode (PRD story 25 — control how much an agent
 * asks). `mode` is a provider-specific schema value (e.g. `default`,
 * `acceptEdits`, `plan`); the supervisor requires it non-empty.
 */
export async function setPermissionMode(
  client: CockpitClient,
  cityName: string,
  sessionId: string,
  mode: string,
): Promise<ApiResult<SessionDetail>> {
  const permissionMode = mode?.trim();
  if (!permissionMode) {
    return validationError("A permission mode is required.");
  }
  return runApi(() =>
    client.POST("/v0/city/{cityName}/session/{id}/permission-mode", {
      params: { path: { cityName, id: sessionId }, header: csrfHeader() },
      body: { permission_mode: permissionMode },
    }),
  );
}
