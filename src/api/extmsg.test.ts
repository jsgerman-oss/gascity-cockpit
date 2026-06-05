import { describe, expect, it } from "vitest";
import { createCockpitClient } from "./client";
import {
  ackTranscript,
  bindSession,
  ensureGroup,
  getGroup,
  getTranscript,
  listAdapters,
  listBindings,
  listCities,
  postInbound,
  postOutbound,
  registerAdapter,
  removeParticipant,
  unbindSession,
  unregisterAdapter,
  upsertParticipant,
} from "./extmsg";
import type { ConversationRef } from "./extmsg";
import { jsonResponse, mockFetch, problemResponse } from "../test/helpers";

function client(handler: (req: Request) => Response | Promise<Response>) {
  const { fetch, calls } = mockFetch(handler);
  return { client: createCockpitClient({ baseUrl: "http://api.test", fetch }), calls };
}

const CITY = "blackrim-hq";
const CONV: ConversationRef = {
  scope_id: "s1",
  provider: "cockpit",
  account_id: "default",
  conversation_id: "c1",
  kind: "dm",
};

describe("extmsg cities", () => {
  it("listCities targets the supervisor cities collection", async () => {
    const { client: c, calls } = client(() =>
      jsonResponse({ items: [{ name: CITY, path: "/x", running: true }], total: 1 }),
    );
    const res = await listCities(c);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.items?.[0]?.name).toBe(CITY);
    expect(new URL(calls[0].url).pathname).toBe("/v0/cities");
    expect(calls[0].method).toBe("GET");
  });
});

describe("extmsg adapters", () => {
  it("registerAdapter posts the full spec with capabilities + callback and the CSRF header", async () => {
    const { client: c, calls } = client(() =>
      jsonResponse({ status: "registered", provider: "cockpit", account_id: "default", name: "VS Code Cockpit" }, { status: 201 }),
    );

    const res = await registerAdapter(c, {
      cityName: CITY,
      provider: "cockpit",
      accountId: "default",
      name: "VS Code Cockpit",
      callbackUrl: "http://127.0.0.1:5555/cb",
      capabilities: { SupportsChildConversations: true, SupportsAttachments: false, MaxMessageLength: 0 },
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ status: "registered", provider: "cockpit" });
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/extmsg/adapters`);
    expect(calls[0].headers.get("x-gc-request")).toBeTruthy();
    expect(await calls[0].clone().json()).toEqual({
      provider: "cockpit",
      account_id: "default",
      name: "VS Code Cockpit",
      callback_url: "http://127.0.0.1:5555/cb",
      capabilities: { SupportsChildConversations: true, SupportsAttachments: false, MaxMessageLength: 0 },
    });
  });

  it("registerAdapter omits optional fields when not given", async () => {
    const { client: c, calls } = client(() =>
      jsonResponse({ status: "registered", provider: "cockpit", account_id: "default", name: "" }, { status: 201 }),
    );
    await registerAdapter(c, { cityName: CITY, provider: "cockpit", accountId: "default" });
    expect(await calls[0].clone().json()).toEqual({ provider: "cockpit", account_id: "default" });
  });

  it("listAdapters reads the adapters collection", async () => {
    const { client: c, calls } = client(() => jsonResponse({ items: [], total: 0 }));
    const res = await listAdapters(c, { cityName: CITY });
    expect(res.ok).toBe(true);
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/extmsg/adapters`);
    expect(calls[0].method).toBe("GET");
  });

  it("unregisterAdapter DELETEs with provider + account_id and the CSRF header", async () => {
    const { client: c, calls } = client(() => jsonResponse({ status: "unregistered" }));
    const res = await unregisterAdapter(c, { cityName: CITY, provider: "cockpit", accountId: "default" });
    expect(res.ok).toBe(true);
    expect(calls[0].method).toBe("DELETE");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/extmsg/adapters`);
    expect(calls[0].headers.get("x-gc-request")).toBeTruthy();
    expect(await calls[0].clone().json()).toEqual({ provider: "cockpit", account_id: "default" });
  });

  it("maps a problem document to an error result", async () => {
    const { client: c } = client(() =>
      problemResponse({ type: "urn:x", title: "Conflict", status: 409, detail: "already registered" }, { status: 409 }),
    );
    const res = await registerAdapter(c, { cityName: CITY, provider: "cockpit", accountId: "default" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatchObject({ status: 409, title: "Conflict" });
  });
});

describe("extmsg bindings", () => {
  it("bindSession posts session_id + conversation", async () => {
    const { client: c, calls } = client(() => jsonResponse({ ID: "b1", SessionID: "mayor-1" }));
    await bindSession(c, { cityName: CITY, sessionId: "mayor-1", conversation: CONV, metadata: { k: "v" } });
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/extmsg/bind`);
    expect(calls[0].headers.get("x-gc-request")).toBeTruthy();
    expect(await calls[0].clone().json()).toEqual({ session_id: "mayor-1", conversation: CONV, metadata: { k: "v" } });
  });

  it("listBindings filters by session_id query", async () => {
    const { client: c, calls } = client(() => jsonResponse({ items: [], total: 0 }));
    await listBindings(c, { cityName: CITY, sessionId: "mayor-1" });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/v0/city/${CITY}/extmsg/bindings`);
    expect(url.searchParams.get("session_id")).toBe("mayor-1");
  });

  it("unbindSession omits conversation to unbind all", async () => {
    const { client: c, calls } = client(() => jsonResponse({ unbound: [] }));
    await unbindSession(c, { cityName: CITY, sessionId: "mayor-1" });
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/extmsg/unbind`);
    expect(await calls[0].clone().json()).toEqual({ session_id: "mayor-1" });
  });
});

describe("extmsg groups & participants", () => {
  it("ensureGroup posts the root conversation + mode", async () => {
    const { client: c, calls } = client(() => jsonResponse({ ID: "g1" }, { status: 201 }));
    await ensureGroup(c, { cityName: CITY, rootConversation: CONV, mode: "launcher", defaultHandle: "@cockpit" });
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/extmsg/groups`);
    expect(await calls[0].clone().json()).toEqual({
      root_conversation: CONV,
      mode: "launcher",
      default_handle: "@cockpit",
    });
  });

  it("getGroup serializes the conversation key as query params", async () => {
    const { client: c, calls } = client(() => jsonResponse({ ID: "g1" }));
    await getGroup(c, { cityName: CITY, scopeId: "s1", provider: "cockpit", conversationId: "c1", kind: "dm" });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/v0/city/${CITY}/extmsg/groups`);
    expect(url.searchParams.get("scope_id")).toBe("s1");
    expect(url.searchParams.get("provider")).toBe("cockpit");
    expect(url.searchParams.get("conversation_id")).toBe("c1");
    expect(url.searchParams.get("kind")).toBe("dm");
  });

  it("upsertParticipant posts group_id + handle + session_id", async () => {
    const { client: c, calls } = client(() => jsonResponse({ ID: "p1", Handle: "@me" }));
    await upsertParticipant(c, { cityName: CITY, groupId: "g1", handle: "@me", sessionId: "mayor-1", public: true });
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/extmsg/participants`);
    expect(await calls[0].clone().json()).toEqual({
      group_id: "g1",
      handle: "@me",
      session_id: "mayor-1",
      public: true,
    });
  });

  it("removeParticipant DELETEs by group_id + handle", async () => {
    const { client: c, calls } = client(() => jsonResponse({ status: "ok" }));
    await removeParticipant(c, { cityName: CITY, groupId: "g1", handle: "@me" });
    expect(calls[0].method).toBe("DELETE");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/extmsg/participants`);
    expect(await calls[0].clone().json()).toEqual({ group_id: "g1", handle: "@me" });
  });
});

describe("extmsg messaging", () => {
  it("postOutbound posts session_id + text + conversation", async () => {
    const { client: c, calls } = client(() => jsonResponse({ Receipt: {}, DeliveryContext: {}, TranscriptEntry: {} }));
    await postOutbound(c, { cityName: CITY, sessionId: "mayor-1", text: "hello", conversation: CONV, idempotencyKey: "k1" });
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/extmsg/outbound`);
    expect(calls[0].headers.get("x-gc-request")).toBeTruthy();
    expect(await calls[0].clone().json()).toEqual({
      session_id: "mayor-1",
      text: "hello",
      conversation: CONV,
      idempotency_key: "k1",
    });
  });

  it("postInbound posts a raw payload with provider + account_id", async () => {
    const { client: c, calls } = client(() => jsonResponse({ Message: {}, Binding: {}, GroupRoute: {}, TranscriptEntry: {}, TargetSessionID: "x" }));
    await postInbound(c, { cityName: CITY, provider: "cockpit", accountId: "default", payload: "deadbeef" });
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/extmsg/inbound`);
    expect(await calls[0].clone().json()).toEqual({ provider: "cockpit", account_id: "default", payload: "deadbeef" });
  });
});

describe("extmsg transcript", () => {
  it("getTranscript serializes the conversation key + paging as query params", async () => {
    const { client: c, calls } = client(() => jsonResponse({ items: [], total: 0 }));
    await getTranscript(c, {
      cityName: CITY,
      scopeId: "s1",
      provider: "cockpit",
      conversationId: "c1",
      kind: "dm",
      afterSequence: 7,
      limit: 50,
      order: "asc",
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/v0/city/${CITY}/extmsg/transcript`);
    expect(url.searchParams.get("scope_id")).toBe("s1");
    expect(url.searchParams.get("after_sequence")).toBe("7");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("order")).toBe("asc");
  });

  it("ackTranscript posts session_id + sequence", async () => {
    const { client: c, calls } = client(() => jsonResponse({ status: "ok" }));
    await ackTranscript(c, { cityName: CITY, sessionId: "mayor-1", conversation: CONV, sequence: 12 });
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/extmsg/transcript/ack`);
    expect(await calls[0].clone().json()).toEqual({ session_id: "mayor-1", conversation: CONV, sequence: 12 });
  });
});
