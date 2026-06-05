import { describe, expect, it } from "vitest";
import { createCockpitClient } from "./client";
import {
  getSession,
  getSessionTranscript,
  listSessions,
  permissionModeOf,
  sendSessionMessage,
  submitToSession,
} from "./sessions";
import type { SessionDetail } from "./types";
import { jsonResponse, mockFetch, problemResponse } from "../test/helpers";

function client(handler: (req: Request) => Response | Promise<Response>) {
  const { fetch, calls } = mockFetch(handler);
  return { client: createCockpitClient({ baseUrl: "http://api.test", fetch }), calls };
}

const CITY = "blackrim-hq";
const SID = "mayor-1";

describe("session reads", () => {
  it("getSessionTranscript interpolates path and serializes query", async () => {
    const body = { format: "conversation", id: SID, provider: "claude", template: "mayor", turns: [{ role: "assistant", text: "hi" }] };
    const { client: c, calls } = client(() => jsonResponse(body));

    const res = await getSessionTranscript(c, { cityName: CITY, id: SID, format: "conversation", tail: "0" });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.turns).toEqual([{ role: "assistant", text: "hi" }]);
    }
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/v0/city/${CITY}/session/${SID}/transcript`);
    expect(url.searchParams.get("format")).toBe("conversation");
    expect(url.searchParams.get("tail")).toBe("0");
    expect(calls[0].method).toBe("GET");
  });

  it("getSession passes peek params", async () => {
    const { client: c, calls } = client(() => jsonResponse({ id: SID }));
    await getSession(c, { cityName: CITY, id: SID, peek: true, peekLines: 5 });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/v0/city/${CITY}/session/${SID}`);
    expect(url.searchParams.get("peek")).toBe("true");
    expect(url.searchParams.get("peek_lines")).toBe("5");
  });

  it("listSessions targets the city sessions collection", async () => {
    const { client: c, calls } = client(() => jsonResponse({ items: [], total: 0 }));
    await listSessions(c, { cityName: CITY, state: "active", limit: 50 });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/v0/city/${CITY}/sessions`);
    expect(url.searchParams.get("state")).toBe("active");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("maps a problem document to an error result", async () => {
    const { client: c } = client(() =>
      problemResponse({ type: "urn:x", title: "Not Found", status: 404, detail: "no session" }, { status: 404 }),
    );
    const res = await getSession(c, { cityName: CITY, id: "nope" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({ status: 404, title: "Not Found", detail: "no session" });
    }
  });
});

describe("session submits", () => {
  it("submitToSession sends message + intent and the anti-CSRF header", async () => {
    const { client: c, calls } = client(() => jsonResponse({ request_id: "r1", event_cursor: "42", status: "accepted" }, { status: 202 }));

    const res = await submitToSession(c, { cityName: CITY, id: SID, message: "go", intent: "interrupt_now" });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toMatchObject({ request_id: "r1", event_cursor: "42" });
    }
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/session/${SID}/submit`);
    expect(calls[0].headers.get("x-gc-request")).toBeTruthy();
    expect(await calls[0].clone().json()).toEqual({ message: "go", intent: "interrupt_now" });
  });

  it("submitToSession omits intent when not given", async () => {
    const { client: c, calls } = client(() => jsonResponse({ request_id: "r", event_cursor: "0", status: "accepted" }, { status: 202 }));
    await submitToSession(c, { cityName: CITY, id: SID, message: "hi" });
    expect(await calls[0].clone().json()).toEqual({ message: "hi" });
  });

  it("sendSessionMessage posts a bare message (no intent) with the anti-CSRF header", async () => {
    const { client: c, calls } = client(() => jsonResponse({ request_id: "r", event_cursor: "1", status: "accepted" }, { status: 202 }));
    await sendSessionMessage(c, { cityName: CITY, id: SID, message: "ask" });
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/session/${SID}/messages`);
    expect(await calls[0].clone().json()).toEqual({ message: "ask" });
    expect(calls[0].headers.get("x-gc-request")).toBeTruthy();
  });
});

describe("permissionModeOf", () => {
  const withOptions = (options?: Record<string, string>): SessionDetail =>
    ({ ...(options ? { options } : {}) }) as unknown as SessionDetail;

  it("reads the mode from a session's options", () => {
    expect(permissionModeOf(withOptions({ permission_mode: "plan" }))).toBe("plan");
  });

  it("returns null when no mode is set", () => {
    expect(permissionModeOf(withOptions({}))).toBeNull();
    expect(permissionModeOf(withOptions())).toBeNull();
  });
});
