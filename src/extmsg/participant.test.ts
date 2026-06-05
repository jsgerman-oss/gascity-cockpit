import { describe, expect, it } from "vitest";
import { createCockpitClient } from "../api/index.ts";
import { mockFetch } from "../test/helpers.ts";
import type { CallbackDelivery, CallbackService, DeliveryHandler } from "./callback-server.ts";
import { ExtMsgParticipant, type RecordedDelivery } from "./participant.ts";

/** A controllable stand-in for the loopback callback server. */
class FakeCallbackService implements CallbackService {
  url: string | null = null;
  onDelivery: DeliveryHandler | undefined;
  startError: Error | null = null;
  started = 0;
  stopped = 0;

  async start(): Promise<string> {
    if (this.startError) throw this.startError;
    // Idempotent, like the real CallbackServer: a second start reuses the bind.
    if (this.url) return this.url;
    this.started += 1;
    this.url = "http://127.0.0.1:5599/extmsg/callback/tok";
    return this.url;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.url = null;
  }

  /** Simulate the supervisor POSTing a delivery. */
  deliver(body: unknown, headers: Record<string, string> = {}): void {
    this.onDelivery?.({ body, headers } satisfies CallbackDelivery);
  }
}

interface RouteResult {
  status?: number;
  body: unknown;
}

/** Build deps with a mock /v0 server keyed by `${METHOD} ${pathname}`. */
function makeDeps(
  routes: (req: Request) => RouteResult,
  opts: { onDelivery?: (d: RecordedDelivery) => void; now?: () => string } = {},
) {
  const calls: Request[] = [];
  const { fetch } = mockFetch((req) => {
    calls.push(req.clone());
    const { status = 200, body } = routes(req);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  const callbackServer = new FakeCallbackService();
  const participant = new ExtMsgParticipant({
    createClient: (ep) => createCockpitClient({ baseUrl: ep.baseUrl, fetch }),
    callbackServer,
    ...(opts.onDelivery ? { onDelivery: opts.onDelivery } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { participant, callbackServer, calls };
}

const ENDPOINT = { baseUrl: "http://api.test" };

function citiesBody(cities: Array<{ name: string; running: boolean }>) {
  return { items: cities.map((c) => ({ ...c, path: `/x/${c.name}` })), total: cities.length };
}

function defaultRoutes(req: Request): RouteResult {
  const { pathname } = new URL(req.url);
  if (pathname === "/v0/cities") {
    return { body: citiesBody([{ name: "a", running: true }, { name: "b", running: false }, { name: "c", running: true }]) };
  }
  if (pathname.endsWith("/extmsg/adapters") && req.method === "POST") {
    return { status: 201, body: { status: "registered", provider: "cockpit", account_id: "default", name: "VS Code Cockpit" } };
  }
  if (pathname.endsWith("/extmsg/adapters") && req.method === "DELETE") {
    return { body: { status: "unregistered" } };
  }
  return { status: 404, body: { type: "x", title: "not found", status: 404 } };
}

describe("ExtMsgParticipant.connect", () => {
  it("registers the adapter in each running city with the reachable callback URL", async () => {
    const { participant, callbackServer, calls } = makeDeps(defaultRoutes);

    await participant.connect(ENDPOINT);

    expect(callbackServer.started).toBe(1);
    expect(participant.callbackUrl).toBe("http://127.0.0.1:5599/extmsg/callback/tok");
    expect(participant.connected).toBe(true);

    const registerCalls = calls.filter((c) => c.url.endsWith("/extmsg/adapters") && c.method === "POST");
    const registeredCities = registerCalls.map((c) => new URL(c.url).pathname.split("/")[3]).sort();
    expect(registeredCities).toEqual(["a", "c"]); // "b" is stopped → skipped

    const body = await registerCalls[0].clone().json();
    expect(body).toMatchObject({
      provider: "cockpit",
      account_id: "default",
      name: "VS Code Cockpit",
      callback_url: "http://127.0.0.1:5599/extmsg/callback/tok",
      capabilities: { SupportsChildConversations: true, SupportsAttachments: false, MaxMessageLength: 0 },
    });

    expect(participant.registrations.map((r) => r.status)).toEqual(["registered", "registered"]);
  });

  it("refuses to register when the callback service fails to start", async () => {
    const { participant, callbackServer, calls } = makeDeps(defaultRoutes);
    callbackServer.startError = new Error("EADDRINUSE");

    await participant.connect(ENDPOINT);

    expect(participant.registrations).toHaveLength(0);
    expect(participant.connected).toBe(false);
    // No API calls at all — not even listing cities.
    expect(calls).toHaveLength(0);
  });

  it("isolates a per-city registration failure", async () => {
    const { participant } = makeDeps((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/v0/cities") return { body: citiesBody([{ name: "a", running: true }, { name: "c", running: true }]) };
      if (pathname === "/v0/city/a/extmsg/adapters") return { status: 409, body: { type: "x", title: "Conflict", status: 409, detail: "dup" } };
      return { status: 201, body: { status: "registered", provider: "cockpit", account_id: "default", name: "x" } };
    });

    await participant.connect(ENDPOINT);

    const byCity = Object.fromEntries(participant.registrations.map((r) => [r.city, r]));
    expect(byCity["a"].status).toBe("error");
    expect(byCity["a"].detail).toContain("Conflict");
    expect(byCity["c"].status).toBe("registered");
  });

  it("records empty registrations when city listing fails", async () => {
    const { participant } = makeDeps((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/v0/cities") return { status: 503, body: { type: "x", title: "down", status: 503 } };
      return { status: 201, body: {} };
    });
    await participant.connect(ENDPOINT);
    expect(participant.registrations).toHaveLength(0);
  });

  it("handles a supervisor with no running cities", async () => {
    const { participant, calls } = makeDeps((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/v0/cities") return { body: citiesBody([{ name: "b", running: false }]) };
      return { status: 201, body: {} };
    });
    await participant.connect(ENDPOINT);
    expect(participant.registrations).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("re-registers on a second connect (durability across restarts)", async () => {
    const { participant, callbackServer, calls } = makeDeps(defaultRoutes);
    await participant.connect(ENDPOINT);
    await participant.connect(ENDPOINT);
    // Callback service is reused (started once), but registration runs again.
    expect(callbackServer.started).toBe(1);
    const registerPosts = calls.filter((c) => c.url.endsWith("/extmsg/adapters") && c.method === "POST");
    expect(registerPosts).toHaveLength(4); // a,c twice
  });
});

describe("ExtMsgParticipant.disconnect / dispose", () => {
  it("unregisters from every registered city and clears state", async () => {
    const { participant, calls } = makeDeps(defaultRoutes);
    await participant.connect(ENDPOINT);

    await participant.disconnect();

    const deleteCities = calls
      .filter((c) => c.url.endsWith("/extmsg/adapters") && c.method === "DELETE")
      .map((c) => new URL(c.url).pathname.split("/")[3])
      .sort();
    expect(deleteCities).toEqual(["a", "c"]);
    expect(participant.registrations).toHaveLength(0);
    expect(participant.connected).toBe(false);
  });

  it("dispose stops the callback service", async () => {
    const { participant, callbackServer } = makeDeps(defaultRoutes);
    await participant.connect(ENDPOINT);
    await participant.dispose();
    expect(callbackServer.stopped).toBe(1);
    expect(callbackServer.onDelivery).toBeUndefined();
  });

  it("unregister failures are swallowed (best-effort)", async () => {
    const { participant } = makeDeps((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/v0/cities") return { body: citiesBody([{ name: "a", running: true }]) };
      if (req.method === "DELETE") return { status: 500, body: { type: "x", title: "boom", status: 500 } };
      return { status: 201, body: { status: "registered", provider: "cockpit", account_id: "default", name: "x" } };
    });
    await participant.connect(ENDPOINT);
    await expect(participant.disconnect()).resolves.toBeUndefined();
    expect(participant.connected).toBe(false);
  });
});

describe("ExtMsgParticipant callback deliveries", () => {
  it("records deliveries with a timestamp and forwards them", async () => {
    const seen: RecordedDelivery[] = [];
    const { participant, callbackServer } = makeDeps(defaultRoutes, {
      onDelivery: (d) => seen.push(d),
      now: () => "2026-06-05T00:00:00.000Z",
    });
    await participant.connect(ENDPOINT);

    callbackServer.deliver({ text: "hi" }, { "x-from": "supervisor" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ body: { text: "hi" }, receivedAt: "2026-06-05T00:00:00.000Z" });
    expect(participant.recentDeliveries).toHaveLength(1);
    expect(participant.recentDeliveries[0].headers["x-from"]).toBe("supervisor");
  });

  it("caps the recent-delivery ring buffer", async () => {
    const callbackServer = new FakeCallbackService();
    const { fetch } = mockFetch(() => new Response("{}"));
    const participant = new ExtMsgParticipant({
      createClient: (ep) => createCockpitClient({ baseUrl: ep.baseUrl, fetch }),
      callbackServer,
      maxDeliveries: 3,
    });
    for (let i = 0; i < 10; i++) callbackServer.deliver({ n: i });
    expect(participant.recentDeliveries).toHaveLength(3);
    expect(participant.recentDeliveries.map((d) => (d.body as { n: number }).n)).toEqual([7, 8, 9]);
  });

  it("a throwing onDelivery callback does not lose the recorded delivery", async () => {
    const callbackServer = new FakeCallbackService();
    const { fetch } = mockFetch(() => new Response("{}"));
    const participant = new ExtMsgParticipant({
      createClient: (ep) => createCockpitClient({ baseUrl: ep.baseUrl, fetch }),
      callbackServer,
      onDelivery: () => {
        throw new Error("boom");
      },
    });
    expect(() => callbackServer.deliver({ x: 1 })).not.toThrow();
    expect(participant.recentDeliveries).toHaveLength(1);
  });
});
