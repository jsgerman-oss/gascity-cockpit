import { afterEach, describe, expect, it } from "vitest";
import { CallbackServer, type CallbackDelivery } from "./callback-server";

let server: CallbackServer | null = null;

afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

async function startServer(opts: ConstructorParameters<typeof CallbackServer>[0] = {}): Promise<CallbackServer> {
  server = new CallbackServer({ token: "secret", ...opts });
  await server.start();
  return server;
}

describe("CallbackServer lifecycle", () => {
  it("binds an ephemeral loopback port and exposes a guarded URL", async () => {
    const s = await startServer();
    expect(s.listening).toBe(true);
    expect(s.port).toBeGreaterThan(0);
    const url = new URL(s.url as string);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/extmsg/callback/secret");
  });

  it("url is null before start and after stop", async () => {
    const s = new CallbackServer({ token: "secret" });
    expect(s.url).toBeNull();
    await s.start();
    expect(s.url).not.toBeNull();
    await s.stop();
    expect(s.url).toBeNull();
    expect(s.listening).toBe(false);
  });

  it("start is idempotent and returns the same URL", async () => {
    const s = await startServer();
    const first = s.url;
    const again = await s.start();
    expect(again).toBe(first);
  });

  it("generates an unguessable token when none is given", async () => {
    server = new CallbackServer();
    await server.start();
    const path = new URL(server.url as string).pathname;
    expect(path).toMatch(/^\/extmsg\/callback\/[0-9a-f]{32}$/);
  });
});

describe("CallbackServer delivery", () => {
  it("accepts a JSON POST, parses the body, and returns 200", async () => {
    const seen: CallbackDelivery[] = [];
    const s = await startServer({ onDelivery: (d) => seen.push(d) });

    const res = await fetch(s.url as string, {
      method: "POST",
      headers: { "content-type": "application/json", "x-extmsg-provider": "cockpit" },
      body: JSON.stringify({ text: "hello", conversation_id: "c1" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual({ text: "hello", conversation_id: "c1" });
    expect(seen[0].headers["x-extmsg-provider"]).toBe("cockpit");
  });

  it("tolerates a non-JSON body by surfacing the raw text", async () => {
    const seen: CallbackDelivery[] = [];
    const s = await startServer({ onDelivery: (d) => seen.push(d) });
    const res = await fetch(s.url as string, { method: "POST", body: "not json" });
    expect(res.status).toBe(200);
    expect(seen[0].body).toBe("not json");
  });

  it("a throwing handler does not crash the server or 500 the caller", async () => {
    const s = await startServer({
      onDelivery: () => {
        throw new Error("boom");
      },
    });
    const res = await fetch(s.url as string, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    // Server still serves after the handler threw.
    expect(await (await fetch(s.url as string, { method: "GET" })).status).toBe(200);
  });

  it("answers GET as a liveness probe", async () => {
    const s = await startServer();
    const res = await fetch(s.url as string, { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", adapter: "cockpit" });
  });

  it("probe() reports reachability", async () => {
    const s = await startServer();
    expect(await s.probe()).toBe(true);
    await s.stop();
    expect(await s.probe()).toBe(false);
  });
});

describe("CallbackServer guards", () => {
  it("returns 404 for any path but the guarded route", async () => {
    const s = await startServer();
    const base = `http://127.0.0.1:${s.port}`;
    expect((await fetch(`${base}/extmsg/callback/wrong`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("returns 405 for unsupported methods on the guarded route", async () => {
    const s = await startServer();
    const res = await fetch(s.url as string, { method: "PUT", body: "{}" });
    expect(res.status).toBe(405);
  });

  it("returns 413 when the body exceeds the cap and does not deliver", async () => {
    const seen: CallbackDelivery[] = [];
    const s = await startServer({ maxBodyBytes: 16, onDelivery: (d) => seen.push(d) });
    const res = await fetch(s.url as string, { method: "POST", body: "x".repeat(1000) });
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });
});
