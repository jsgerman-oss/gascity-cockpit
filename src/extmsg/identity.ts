// The Cockpit's extmsg adapter identity.
//
// These constants mirror the pack's `contract/v0.toml` `[extmsg]` block, which
// is the source of truth (see `pack/cockpit/contract.py::adapter_registration_spec`
// and `docs/DESIGN.md` fork #2). The pack ships the *spec*; this host performs
// the actual runtime registration (cockpit-1ll.12), so the values must agree.
// Field casing deliberately matches the live `AdapterCapabilities` schema:
// snake_case envelope, PascalCase capability keys.
import type { AdapterCapabilities, RegisterAdapterParams } from "../api/index.ts";

/** Provider key the Cockpit registers under, per `contract/v0.toml`. */
export const COCKPIT_ADAPTER_PROVIDER = "cockpit";

/** Default account id — one Cockpit per machine maps to a single account. */
export const COCKPIT_ADAPTER_ACCOUNT_ID = "default";

/** Display name shown in extmsg participant lists. */
export const COCKPIT_ADAPTER_NAME = "VS Code Cockpit";

/**
 * Capabilities the Cockpit advertises. `MaxMessageLength: 0` means unbounded.
 * Mirrors `supports_child_conversations` / `supports_attachments` /
 * `max_message_length` in `contract/v0.toml`.
 */
export const COCKPIT_ADAPTER_CAPABILITIES: AdapterCapabilities = {
  SupportsChildConversations: true,
  SupportsAttachments: false,
  MaxMessageLength: 0,
};

/** The Cockpit's adapter identity — the parts that don't depend on the city. */
export interface AdapterIdentity {
  provider: string;
  accountId: string;
  name: string;
  capabilities: AdapterCapabilities;
}

/** The default Cockpit adapter identity (overridable per deployment/test). */
export const COCKPIT_ADAPTER_IDENTITY: AdapterIdentity = {
  provider: COCKPIT_ADAPTER_PROVIDER,
  accountId: COCKPIT_ADAPTER_ACCOUNT_ID,
  name: COCKPIT_ADAPTER_NAME,
  capabilities: COCKPIT_ADAPTER_CAPABILITIES,
};

/**
 * Build the {@link RegisterAdapterParams} for a city from an identity and the
 * reachable callback URL. The TypeScript twin of the pack's
 * `adapter_registration_spec` — same provider / account_id / name / capabilities,
 * and `callback_url` only when one is reachable.
 */
export function cockpitAdapterSpec(
  cityName: string,
  identity: AdapterIdentity,
  callbackUrl?: string,
): RegisterAdapterParams {
  return {
    cityName,
    provider: identity.provider,
    accountId: identity.accountId,
    name: identity.name,
    capabilities: identity.capabilities,
    ...(callbackUrl ? { callbackUrl } : {}),
  };
}
