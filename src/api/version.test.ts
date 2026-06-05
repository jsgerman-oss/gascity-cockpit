import { describe, expect, it } from "vitest";
import { createCockpitClient } from "./client";
import {
  checkApiCompatibility,
  isReleaseVersion,
  PINNED_API_VERSION,
} from "./version";
import { jsonResponse, mockFetch, problemResponse } from "../test/helpers";
import type { SupervisorHealth } from "./types";

function health(overrides: Partial<SupervisorHealth> = {}): SupervisorHealth {
  return {
    status: "ok",
    version: PINNED_API_VERSION,
    cities_total: 1,
    cities_running: 1,
    uptime_sec: 1,
    ...overrides,
  };
}

function clientReturning(body: unknown, opts?: { status?: number; problem?: boolean }) {
  const { fetch } = mockFetch(() =>
    opts?.problem
      ? problemResponse(body, { status: opts.status ?? 500 })
      : jsonResponse(body, { status: opts?.status ?? 200 }),
  );
  return createCockpitClient({ baseUrl: "http://api.test", fetch });
}

describe("isReleaseVersion", () => {
  it("recognises semver releases", () => {
    expect(isReleaseVersion("0.1.0")).toBe(true);
    expect(isReleaseVersion("1.2.3")).toBe(true);
    expect(isReleaseVersion("0.1.0-rc.1")).toBe(true);
  });

  it("rejects dev/unversioned builds", () => {
    expect(isReleaseVersion("dev")).toBe(false);
    expect(isReleaseVersion("")).toBe(false);
    expect(isReleaseVersion("unknown")).toBe(false);
    expect(isReleaseVersion("abc123")).toBe(false);
  });
});

describe("checkApiCompatibility", () => {
  it("reports a match when the live version equals the pinned version", async () => {
    const compat = await checkApiCompatibility(clientReturning(health()));
    expect(compat.status).toBe("match");
    expect(compat.ok).toBe(true);
    expect(compat.liveVersion).toBe(PINNED_API_VERSION);
  });

  it("treats a dev build as ok-with-warning", async () => {
    const compat = await checkApiCompatibility(
      clientReturning(health({ version: "dev", build_id: "abc123-dirty" })),
    );
    expect(compat.status).toBe("dev-build");
    expect(compat.ok).toBe(true);
    expect(compat.liveBuildId).toBe("abc123-dirty");
    expect(compat.message).toContain("dev build");
  });

  it("flags a version mismatch", async () => {
    const compat = await checkApiCompatibility(clientReturning(health({ version: "9.9.9" })));
    expect(compat.status).toBe("mismatch");
    expect(compat.ok).toBe(false);
    expect(compat.message).toContain("9.9.9");
    expect(compat.message).toContain(PINNED_API_VERSION);
  });

  it("reports unreachable on a server error response", async () => {
    const compat = await checkApiCompatibility(
      clientReturning({ type: "about:blank", title: "Internal Server Error", status: 500 }, {
        problem: true,
        status: 500,
      }),
    );
    expect(compat.status).toBe("unreachable");
    expect(compat.ok).toBe(false);
    expect(compat.error).toBeDefined();
  });

  it("reports unreachable when fetch rejects (network down)", async () => {
    const { fetch } = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = createCockpitClient({ baseUrl: "http://api.test", fetch });
    const compat = await checkApiCompatibility(client);
    expect(compat.status).toBe("unreachable");
    expect(compat.ok).toBe(false);
    expect(compat.error?.title).toBe("Network error");
  });
});
