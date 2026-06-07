// Orchestration / smoke tests for the companion. The app is DOM-free by design,
// so these drive it in plain Node with a fake `mount`, asserting the
// loading → ready / error transitions, the live event feed, endpoint resolution,
// and teardown — with no browser and no real supervisor.
//
// The headline "smoke test against a mock /v0" (cockpit-tzy acceptance) is the
// first case: it constructs the app with its REAL default seams — the same
// `FleetStatusStore`, `LiveStatus`, typed client, and `SupervisorEventStream` the
// VS Code extension uses — and points them at a mock `/v0` via a stubbed global
// `fetch`, proving the shared client + store work end-to-end outside the editor.
import { describe, expect, it, vi } from "vitest";
import * as core from "../../src/core/index.ts";
import { type PaneId, DEFAULT_ENDPOINT, createCompanionApp, resolveEndpoint } from "./app.ts";

/** Records the latest HTML mounted per pane, plus a call log. */
function recorder() {
  const last: Partial<Record<PaneId, string>> = {};
  const calls: Array<[PaneId, string]> = [];
  return {
    mount: (pane: PaneId, html: string) => {
      last[pane] = html;
      calls.push([pane, html]);
    },
    last,
    calls,
  };
}

/** A controllable stand-in for the SSE event stream (structurally cast). */
function fakeStream() {
  let eventCb: ((e: core.status.FleetEvent) => void) | undefined;
  let statusCb: ((s: core.status.EventStreamStatus) => void) | undefined;
  const state = { started: false, disposed: false };
  const stream = {
    onEvent: (cb: (e: core.status.FleetEvent) => void) => {
      eventCb = cb;
      return { dispose() {} };
    },
    onStatus: (cb: (s: core.status.EventStreamStatus) => void) => {
      statusCb = cb;
      return { dispose() {} };
    },
    start: () => {
      state.started = true;
    },
    dispose: () => {
      state.disposed = true;
    },
  };
  return {
    stream: stream as unknown as core.status.SupervisorEventStream,
    emitEvent: (e: core.status.FleetEvent) => eventCb?.(e),
    emitStatus: (s: core.status.EventStreamStatus) => statusCb?.(s),
    state,
  };
}

/** The URL of a fetch input, however openapi-fetch / openSSE pass it. */
function urlOf(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(String(input));
}

/**
 * A mock `/v0` server as a `fetch`. `mode: "ok"` serves one running city with an
 * agent and an SSE stream that emits a single event; `mode: "down"` 500s every
 * call. `counts` lets a test see how often an endpoint was hit (for refresh).
 */
function mockV0(mode: "ok" | "down" = "ok") {
  const counts: Record<string, number> = {};
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = urlOf(input).pathname;
    counts[path] = (counts[path] ?? 0) + 1;
    if (mode === "down") {
      return json({ type: "about:blank", title: "Internal Error", status: 500 }, 500);
    }
    if (path === "/health") {
      return json({ status: "ok", version: "1.2.3", cities_running: 1, cities_total: 1, uptime_sec: 42 });
    }
    if (path === "/v0/cities") return json({ items: [{ name: "alpha", running: true }] });
    if (path.endsWith("/agents")) {
      return json({ items: [{ name: "furiosa", state: "idle", running: false, available: true }] });
    }
    if (path.endsWith("/sessions")) return json({ items: [] });
    if (path === "/v0/events/stream") {
      const evt = { seq: 1, type: "session.updated", ts: "2026-06-06T19:00:00Z", actor: "furiosa", city: "alpha" };
      const body = `id: 1\nevent: message\ndata: ${JSON.stringify(evt)}\n\n`;
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { fetch: fetchImpl, counts };
}

describe("resolveEndpoint", () => {
  it("defaults to the page origin (same-origin via the launch proxy)", () => {
    expect(resolveEndpoint({ search: "", origin: "http://127.0.0.1:4180" })).toEqual({
      baseUrl: "http://127.0.0.1:4180",
    });
  });

  it("honours an explicit ?endpoint override", () => {
    expect(resolveEndpoint({ search: "?endpoint=http://host:8372", origin: "http://127.0.0.1:4180" })).toEqual({
      baseUrl: "http://host:8372",
    });
  });

  it("threads a ?token bearer onto the endpoint", () => {
    expect(resolveEndpoint({ search: "?endpoint=http://h:1&token=abc", origin: "http://p" })).toEqual({
      baseUrl: "http://h:1",
      token: "abc",
    });
  });

  it("falls back to the localhost default for a non-HTTP origin (file://)", () => {
    expect(resolveEndpoint({ search: "", origin: "null" })).toEqual({ baseUrl: DEFAULT_ENDPOINT });
  });
});

describe("createCompanionApp", () => {
  it("exposes a runnable app with the real default seams", () => {
    const app = createCompanionApp({ endpoint: { baseUrl: DEFAULT_ENDPOINT }, mount: () => {} });
    expect(typeof app.start).toBe("function");
    expect(typeof app.refresh).toBe("function");
    expect(typeof app.dispose).toBe("function");
  });

  it("renders live city health from a mock /v0 over the real client + store (smoke)", async () => {
    const rec = recorder();
    const v0 = mockV0("ok");
    vi.stubGlobal("fetch", v0.fetch);
    try {
      // No injected seams: this exercises the REAL FleetStatusStore, LiveStatus,
      // typed client, and SupervisorEventStream — only the transport is a mock.
      const app = createCompanionApp({ endpoint: { baseUrl: "http://mock" }, mount: rec.mount });
      app.start();
      // Loading is mounted synchronously, before any fetch resolves.
      expect(rec.last.health).toContain("notice--loading");

      await vi.waitFor(() => expect(rec.last.health).toContain("alpha"));
      expect(rec.last.health).toContain("Supervisor — ok");
      expect(rec.last.health).toContain("furiosa");
      expect(v0.counts["/v0/cities"]).toBeGreaterThanOrEqual(1);
      app.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders the live event feed as events arrive over the (fake) stream", () => {
    const rec = recorder();
    const v0 = mockV0("ok");
    const fake = fakeStream();
    const app = createCompanionApp({
      endpoint: { baseUrl: "http://mock" },
      mount: rec.mount,
      createClient: () => core.api.createCockpitClient({ baseUrl: "http://mock", fetch: v0.fetch }),
      createStream: () => fake.stream,
    });

    app.start();
    expect(fake.state.started).toBe(true);
    // Event-sourced: the feed sits on the connecting row until the stream speaks.
    expect(rec.last.events).toContain("notice--loading");

    fake.emitStatus({ state: "open", detail: "connected", attempt: 0 });
    fake.emitEvent({ seq: 1, type: "session.updated", ts: "2026-06-06T19:00:00Z", actor: "furiosa", city: "alpha" });
    expect(rec.last.events).toContain("session.updated");
    expect(rec.last.events).toContain("Event stream — open");

    fake.emitStatus({ state: "reconnecting", detail: "retrying in 1200ms (attempt 2)", attempt: 2 });
    expect(rec.last.events).toContain("Event stream — reconnecting");
    app.dispose();
  });

  it("surfaces a consistent error notice when the supervisor is unreachable", async () => {
    const rec = recorder();
    const v0 = mockV0("down");
    const fake = fakeStream();
    const app = createCompanionApp({
      endpoint: { baseUrl: "http://mock" },
      mount: rec.mount,
      createClient: () => core.api.createCockpitClient({ baseUrl: "http://mock", fetch: v0.fetch }),
      createStream: () => fake.stream,
    });

    app.start();
    await vi.waitFor(() => expect(rec.last.health).toContain("Couldn&#39;t load the fleet."));
    app.dispose();
  });

  it("re-snapshots city health on refresh()", async () => {
    const rec = recorder();
    const v0 = mockV0("ok");
    const fake = fakeStream();
    const app = createCompanionApp({
      endpoint: { baseUrl: "http://mock" },
      mount: rec.mount,
      createClient: () => core.api.createCockpitClient({ baseUrl: "http://mock", fetch: v0.fetch }),
      createStream: () => fake.stream,
    });

    app.start();
    await vi.waitFor(() => expect(rec.last.health).toContain("alpha"));
    const before = v0.counts["/v0/cities"] ?? 0;

    app.refresh();
    await vi.waitFor(() => expect(v0.counts["/v0/cities"] ?? 0).toBeGreaterThan(before));
    app.dispose();
  });

  it("tears down the stream and stops rendering on dispose", () => {
    const rec = recorder();
    const fake = fakeStream();
    const app = createCompanionApp({
      endpoint: { baseUrl: "http://mock" },
      mount: rec.mount,
      createClient: () => core.api.createCockpitClient({ baseUrl: "http://mock", fetch: mockV0("ok").fetch }),
      createStream: () => fake.stream,
    });

    app.start();
    app.dispose();
    expect(fake.state.disposed).toBe(true);

    // After dispose the render subscription is gone, so a late event mounts nothing.
    const mountsAfterDispose = rec.calls.length;
    fake.emitEvent({ seq: 9, type: "session.updated", ts: "", actor: "x", city: "alpha" });
    expect(rec.calls.length).toBe(mountsAfterDispose);
  });
});
