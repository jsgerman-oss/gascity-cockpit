// API version pinning and runtime compatibility.
//
// The client is generated against a snapshot of /openapi.json, which pins the
// /v0 contract version (PINNED_API_VERSION). At runtime the supervisor reports
// its build via GET /health. This module compares the two so the Cockpit can
// warn on drift — the supervisor is "a moving dev build" (PRD Further Notes /
// Risk), so the check is informative, not a hard gate.
import type { CockpitClient } from "./client";
import { normalizeError, type NormalizedError } from "./client";
import { PINNED_API_TITLE, PINNED_API_VERSION } from "./generated/spec-meta";
import type { SupervisorHealth } from "./types";

export { PINNED_API_TITLE, PINNED_API_VERSION };

export type CompatibilityStatus =
  /** Live version equals the pinned contract version. */
  | "match"
  /** Live version is a dev/unversioned build; drift is possible but expected. */
  | "dev-build"
  /** Live version is a different release than the client was generated against. */
  | "mismatch"
  /** The supervisor could not be reached or did not return health. */
  | "unreachable";

export interface ApiCompatibility {
  /** True when it is safe to proceed without regenerating the client. */
  ok: boolean;
  status: CompatibilityStatus;
  /** Contract version the client was generated against. */
  pinnedVersion: string;
  /** Version reported by the live supervisor, when reachable. */
  liveVersion?: string;
  /** Build identity reported by the live supervisor, when present. */
  liveBuildId?: string;
  /** Full health body, when reachable. */
  health?: SupervisorHealth;
  /** One-line, human-readable summary suitable for a notification. */
  message: string;
  /** Present when status is `unreachable`. */
  error?: NormalizedError;
}

/**
 * A version string is treated as a real release when it looks like semver
 * (`MAJOR.MINOR.PATCH`). Anything else — `dev`, ``, `unknown`, a bare commit —
 * is a dev build, where contract drift against the pinned snapshot is expected.
 */
export function isReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+/.test(version.trim());
}

/**
 * Fetch GET /health and compare the live supervisor version against the pinned
 * /v0 contract version. Never throws — failures surface as `unreachable`.
 */
export async function checkApiCompatibility(client: CockpitClient): Promise<ApiCompatibility> {
  let data: SupervisorHealth | undefined;
  let error: unknown;
  let response: Response | undefined;
  try {
    ({ data, error, response } = await client.GET("/health"));
  } catch (thrown) {
    // openapi-fetch lets network/abort rejections propagate; map them too.
    const normalized = normalizeError(thrown);
    return {
      ok: false,
      status: "unreachable",
      pinnedVersion: PINNED_API_VERSION,
      message: `Supervisor API unreachable: ${normalized.title}`,
      error: normalized,
    };
  }

  if (error !== undefined || !data) {
    const normalized = normalizeError(error, response);
    return {
      ok: false,
      status: "unreachable",
      pinnedVersion: PINNED_API_VERSION,
      message: `Supervisor API unreachable: ${normalized.title}`,
      error: normalized,
    };
  }

  const liveVersion = data.version;
  const liveBuildId = data.build_id || undefined;
  const base = {
    pinnedVersion: PINNED_API_VERSION,
    liveVersion,
    liveBuildId,
    health: data,
  };

  if (!isReleaseVersion(liveVersion)) {
    const build = liveBuildId ? `, build ${liveBuildId}` : "";
    return {
      ...base,
      ok: true,
      status: "dev-build",
      message:
        `Connected to a dev build (version "${liveVersion}"${build}). ` +
        `Client pinned to ${PINNED_API_TITLE} /v0 ${PINNED_API_VERSION}; contract drift is possible.`,
    };
  }

  if (liveVersion === PINNED_API_VERSION) {
    return {
      ...base,
      ok: true,
      status: "match",
      message: `Connected. /v0 ${liveVersion} matches the pinned client contract.`,
    };
  }

  return {
    ...base,
    ok: false,
    status: "mismatch",
    message:
      `/v0 version mismatch: supervisor reports ${liveVersion}, client pinned to ${PINNED_API_VERSION}. ` +
      `Regenerate the client with \`npm run generate:live\`.`,
  };
}
