import { describe, expect, it } from "vitest";
import { bearerAuthHeader, createCockpitClient, normalizeError, normalizeBaseUrl, withTimeout } from "./client";
import { jsonResponse, mockFetch, problemResponse } from "../test/helpers";
import type { SupervisorHealth } from "./types";

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:8372/")).toBe("http://127.0.0.1:8372");
    expect(normalizeBaseUrl("http://127.0.0.1:8372///")).toBe("http://127.0.0.1:8372");
    expect(normalizeBaseUrl("http://127.0.0.1:8372")).toBe("http://127.0.0.1:8372");
  });
});

describe("createCockpitClient", () => {
  it("issues a typed GET and parses the JSON body", async () => {
    const health: SupervisorHealth = {
      status: "ok",
      version: "0.1.0",
      cities_total: 1,
      cities_running: 1,
      uptime_sec: 42,
    };
    const { fetch, calls } = mockFetch(() => jsonResponse(health));
    const client = createCockpitClient({ baseUrl: "http://api.test", fetch });

    const { data, error } = await client.GET("/health");

    expect(error).toBeUndefined();
    expect(data).toEqual(health);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe("/health");
    expect(calls[0].method).toBe("GET");
  });

  it("interpolates path params and serializes query params", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ items: [], total: 0 }),
    );
    const client = createCockpitClient({ baseUrl: "http://api.test", fetch });

    await client.GET("/v0/city/{cityName}/beads", {
      params: {
        path: { cityName: "blackrim-hq" },
        query: { status: "open", limit: 10, all: false },
      },
    });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v0/city/blackrim-hq/beads");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("all")).toBe("false");
  });

  it("url-encodes path params", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const client = createCockpitClient({ baseUrl: "http://api.test", fetch });

    await client.GET("/v0/city/{cityName}/bead/{id}", {
      params: { path: { cityName: "blackrim hq", id: "cockpit-1ll.1" } },
    });

    expect(new URL(calls[0].url).pathname).toBe("/v0/city/blackrim%20hq/bead/cockpit-1ll.1");
  });

  it("sends a default Accept: application/json header", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const client = createCockpitClient({ baseUrl: "http://api.test", fetch });
    await client.GET("/health");
    expect(calls[0].headers.get("accept")).toContain("application/json");
  });

  it("surfaces error bodies on non-2xx responses", async () => {
    const problem = {
      type: "urn:gascity:error:sling-missing-bead",
      title: "Not Found",
      status: 404,
      detail: "bead xyz does not exist",
    };
    const { fetch } = mockFetch(() => problemResponse(problem, { status: 404 }));
    const client = createCockpitClient({ baseUrl: "http://api.test", fetch });

    const { data, error } = await client.GET("/health");

    expect(data).toBeUndefined();
    expect(error).toMatchObject({ title: "Not Found", status: 404 });
  });
});

describe("bearerAuthHeader", () => {
  it("builds an Authorization header for a token", () => {
    expect(bearerAuthHeader("sekret")).toEqual({ Authorization: "Bearer sekret" });
  });

  it("returns undefined when there is no token (null / undefined / empty)", () => {
    expect(bearerAuthHeader(null)).toBeUndefined();
    expect(bearerAuthHeader(undefined)).toBeUndefined();
    expect(bearerAuthHeader("")).toBeUndefined();
  });

  it("threads the bearer token onto every request when present", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const client = createCockpitClient({
      baseUrl: "http://api.test",
      fetch,
      headers: bearerAuthHeader("sekret"),
    });
    await client.GET("/health");
    expect(calls[0].headers.get("authorization")).toBe("Bearer sekret");
  });

  it("sends no Authorization header on the unauthenticated path", async () => {
    // The clean `headers: bearerAuthHeader(token)` call form relies on an absent
    // token spreading to nothing rather than emitting an empty/invalid header.
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const client = createCockpitClient({
      baseUrl: "http://api.test",
      fetch,
      headers: bearerAuthHeader(null),
    });
    await client.GET("/health");
    expect(calls[0].headers.get("authorization")).toBeNull();
  });
});

describe("withTimeout", () => {
  function capturingFetch() {
    let received: AbortSignal | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      received = init?.signal ?? undefined;
      return new Response("{}");
    }) as typeof fetch;
    return { fetch: fetchImpl, signal: () => received };
  }

  it("returns the base fetch unchanged when no timeout is set", () => {
    const base = (async () => new Response("{}")) as typeof fetch;
    expect(withTimeout(base, 0)).toBe(base);
    expect(withTimeout(base, undefined)).toBe(base);
  });

  it("attaches an abort signal to each request", async () => {
    const cap = capturingFetch();
    await withTimeout(cap.fetch, 10_000)("http://api.test");
    expect(cap.signal()).toBeInstanceOf(AbortSignal);
  });

  it("honours a caller signal passed via init", async () => {
    const cap = capturingFetch();
    const controller = new AbortController();
    await withTimeout(cap.fetch, 10_000)("http://api.test", { signal: controller.signal });
    expect(cap.signal()!.aborted).toBe(false);
    controller.abort();
    expect(cap.signal()!.aborted).toBe(true);
  });

  it("honours a signal baked into a Request input", async () => {
    const cap = capturingFetch();
    const controller = new AbortController();
    await withTimeout(cap.fetch, 10_000)(new Request("http://api.test", { signal: controller.signal }));
    expect(cap.signal()!.aborted).toBe(false);
    controller.abort();
    expect(cap.signal()!.aborted).toBe(true);
  });
});

describe("normalizeError", () => {
  it("maps an RFC 7807 problem document", () => {
    const response = new Response(null, {
      status: 404,
      headers: { "X-GC-Request-Id": "req-123" },
    });
    const normalized = normalizeError(
      { type: "urn:gascity:error:x", title: "Not Found", status: 404, detail: "missing" },
      response,
    );
    expect(normalized).toMatchObject({
      status: 404,
      title: "Not Found",
      detail: "missing",
      requestId: "req-123",
    });
  });

  it("maps an abort/timeout error", () => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    const normalized = normalizeError(err);
    expect(normalized.status).toBe(0);
    expect(normalized.title).toBe("Request timed out");
  });

  it("maps a generic network error", () => {
    const normalized = normalizeError(new TypeError("fetch failed"));
    expect(normalized.title).toBe("Network error");
    expect(normalized.detail).toBe("fetch failed");
  });

  it("falls back for unknown values", () => {
    const normalized = normalizeError("weird");
    expect(normalized.title).toBe("Request failed");
    expect(normalized.status).toBe(0);
  });
});
