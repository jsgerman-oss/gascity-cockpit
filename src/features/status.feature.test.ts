/**
 * Coverage suite for the status feature (cockpit-g5l.2).
 *
 * The status feature owns the live Fleet + Event Feed: it builds a `vscode`-free
 * store/live pair and connects the SSE stream only to a *fully-connected*
 * supervisor — reconnecting on a restart or endpoint/token change, tearing down
 * when the API goes away, and deduping a connected endpoint (`liveKey`) so routine
 * health polls don't churn the stream. The central test sweeps every status
 * transition and asserts the stream opens, dedupes, reconnects and tears down
 * exactly as the feature's `applyLiveStatus` guard dictates — covering each branch.
 *
 * It runs in plain Node: the snapshot client and the real `SupervisorEventStream`
 * both reach the network through the global `fetch`, which is stubbed here. The
 * SSE open is parked until the connection aborts, so there is never a real socket,
 * a reconnect, or a backoff timer — the stream's teardown (disconnect / dispose)
 * resolves the parked open via the abort signal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import statusFeature from "./status.feature.ts";
import { createCockpitClient } from "../api/index.ts";
import type { ApiEndpoint } from "../discovery/index.ts";
import { createTestbed, type Testbed } from "../test/fake-host.ts";
import { jsonResponse } from "../test/helpers.ts";

const EP_A: ApiEndpoint = { baseUrl: "http://api.a", token: "tok-a", mode: "supervisor", source: "default" };
const EP_A_NOTOKEN: ApiEndpoint = { baseUrl: "http://api.a", token: null, mode: "supervisor", source: "default" };

/** Build the client the host hands the live status (over the stubbed fetch). */
const mkClient = (ep: { baseUrl: string }) => createCockpitClient({ baseUrl: ep.baseUrl });

/** Every `/v0/events/stream` open the real SupervisorEventStream attempted. */
const sseOpens: string[] = [];

function pathOf(input: unknown): string {
  try {
    if (typeof input === "string") return new URL(input).pathname;
    if (input instanceof URL) return input.pathname;
    if (input instanceof Request) return new URL(input.url).pathname;
  } catch {
    /* unparseable — fall through to "" */
  }
  return "";
}

/**
 * Stub global fetch: park the SSE open until the stream aborts (no socket, no
 * reconnect/backoff), and answer the snapshot endpoints with a minimal healthy
 * fleet so `live.connect()`'s refresh settles cleanly.
 */
function installFetch(): void {
  const fetchMock = (input: unknown, init?: RequestInit): Promise<Response> => {
    const path = pathOf(input);
    if (path === "/v0/events/stream") {
      sseOpens.push(path);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (path === "/health") {
      return Promise.resolve(
        jsonResponse({ status: "ok", version: "0.1.0", uptime_sec: 1, cities_total: 0, cities_running: 0, startup: { ready: true } }),
      );
    }
    return Promise.resolve(jsonResponse({ total: 0, items: [] }));
  };
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
}

let tb: Testbed | undefined;

beforeEach(() => {
  sseOpens.length = 0;
  installFetch();
});

afterEach(() => {
  tb?.disposeAll();
  tb = undefined;
  vi.unstubAllGlobals();
});

describe("status feature", () => {
  it("registers the Fleet + Event Feed views and the refresh command", () => {
    tb = createTestbed({ createClient: mkClient });
    tb.activate(statusFeature);

    expect(tb.getView("gascityCockpit.fleet")).toBeDefined();
    expect(tb.getView("gascityCockpit.events")).toBeDefined();
    expect(tb.hasCommand("gascityCockpit.refreshStatus")).toBe(true);
  });

  it("connects, dedupes, reconnects and tears down across status transitions", async () => {
    tb = createTestbed({ createClient: mkClient });
    tb.activate(statusFeature);

    const sse = () => sseOpens.length;
    const step = async (fire: () => void): Promise<number> => {
      const before = sse();
      fire();
      await tb!.flush();
      return sse() - before;
    };

    // connecting: neither the connect nor the teardown branch fires.
    expect(await step(() => tb!.emitStatus("connecting"))).toBe(0);
    // first connect (endpoint with token): opens the stream.
    expect(await step(() => tb!.emitStatus("connected", { endpoint: EP_A }))).toBe(1);
    // same endpoint, no restart: deduped by liveKey → no new stream.
    expect(await step(() => tb!.emitStatus("connected", { endpoint: EP_A }))).toBe(0);
    // explicit restart on the same endpoint: reconnect.
    expect(await step(() => tb!.emitStatus("connected", { endpoint: EP_A, restarted: true }))).toBe(1);
    // token drops (liveKey changes): reconnect onto the token-less endpoint.
    expect(await step(() => tb!.emitStatus("connected", { endpoint: EP_A_NOTOKEN }))).toBe(1);
    // connected but no endpoint resolved: nothing to connect to.
    expect(await step(() => tb!.emitStatus("connected", { endpoint: null }))).toBe(0);
    // API drops out: disconnect + clear the snapshot (no new stream).
    expect(await step(() => tb!.emitStatus("unavailable"))).toBe(0);
    // idle while already disconnected: nothing to tear down.
    expect(await step(() => tb!.emitStatus("idle"))).toBe(0);
    // reconnecting after idle proves the live key was reset on teardown.
    expect(await step(() => tb!.emitStatus("connected", { endpoint: EP_A }))).toBe(1);
  });

  it("refreshStatus forces a snapshot refresh without throwing", async () => {
    tb = createTestbed({ createClient: mkClient });
    tb.activate(statusFeature);
    tb.emitStatus("connected", { endpoint: EP_A });
    await tb.flush();

    await expect(tb.invokeCommand("gascityCockpit.refreshStatus")).resolves.not.toThrow();
  });

  it("disposeAll disconnects the stream and disposes the store cleanly", async () => {
    tb = createTestbed({ createClient: mkClient });
    tb.activate(statusFeature);
    tb.emitStatus("connected", { endpoint: EP_A });
    await tb.flush();
    expect(sseOpens.length).toBe(1);

    expect(() => tb!.disposeAll()).not.toThrow();
    tb = undefined; // already torn down — keep afterEach from double-disposing.
  });
});
