import { describe, expect, it } from "vitest";
import { createCockpitClient } from "./client";
import { jsonResponse, mockFetch, problemResponse } from "../test/helpers";
import {
  approve,
  deny,
  getSessionPending,
  isPromptForInput,
  isToolApproval,
  listCityPending,
  PENDING_KIND_PROMPT_FOR_INPUT,
  PENDING_KIND_TOOL_APPROVAL,
  respond,
  RESPOND_ACTION_ALLOW,
  RESPOND_ACTION_DENY,
  setPermissionMode,
} from "./approvals";

/** A client wired to a mock /v0 server, plus the requests it issued. */
function clientFor(handler: (req: Request) => Response | Promise<Response>) {
  const { fetch, calls } = mockFetch(handler);
  const client = createCockpitClient({ baseUrl: "http://api.test", fetch });
  return { client, calls };
}

const ACCEPTED = () => jsonResponse({ id: "sess-1", status: "accepted" }, { status: 202 });

describe("listCityPending", () => {
  it("maps the list body and hits GET /v0/city/{city}/pending", async () => {
    const body = {
      items: [
        { kind: PENDING_KIND_TOOL_APPROVAL, request_id: "r1", session_id: "s1" },
        { kind: PENDING_KIND_PROMPT_FOR_INPUT, request_id: "r2", session_id: "s2" },
      ],
      partial: false,
      partial_errors: [],
      total: 2,
    };
    const { client, calls } = clientFor(() => jsonResponse(body));

    const res = await listCityPending(client, "blackrim-hq");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.entries).toHaveLength(2);
      expect(res.data.entries[0].session_id).toBe("s1");
      expect(res.data.total).toBe(2);
      expect(res.data.partial).toBe(false);
      expect(res.data.partialErrors).toEqual([]);
    }
    expect(calls[0].method).toBe("GET");
    expect(new URL(calls[0].url).pathname).toBe("/v0/city/blackrim-hq/pending");
  });

  it("defaults null items / missing partial fields", async () => {
    const { client } = clientFor(() => jsonResponse({ items: null, partial_errors: null, total: 0 }));

    const res = await listCityPending(client, "c");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.entries).toEqual([]);
      expect(res.data.partial).toBe(false);
      expect(res.data.partialErrors).toEqual([]);
    }
  });

  it("surfaces partial aggregation so nothing blocks unseen", async () => {
    const { client } = clientFor(() =>
      jsonResponse({ items: [], partial: true, partial_errors: ["rig beta unreachable"], total: 0 }),
    );

    const res = await listCityPending(client, "c");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.partial).toBe(true);
      expect(res.data.partialErrors).toEqual(["rig beta unreachable"]);
    }
  });

  it("returns a failure on a non-2xx response", async () => {
    const { client } = clientFor(() =>
      problemResponse({ type: "urn:x", title: "Boom", status: 500 }, { status: 500 }),
    );

    const res = await listCityPending(client, "c");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.status).toBe(500);
  });
});

describe("getSessionPending", () => {
  it("returns the pending interaction and supported flag", async () => {
    const pending = {
      kind: PENDING_KIND_PROMPT_FOR_INPUT,
      request_id: "r2",
      prompt: "Which branch?",
      options: ["main", "dev"],
    };
    const { client, calls } = clientFor(() => jsonResponse({ pending, supported: true }));

    const res = await getSessionPending(client, "blackrim-hq", "sess-1");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.pending).toEqual(pending);
      expect(res.data.supported).toBe(true);
    }
    expect(new URL(calls[0].url).pathname).toBe("/v0/city/blackrim-hq/session/sess-1/pending");
  });

  it("normalizes an absent pending interaction to null", async () => {
    const { client } = clientFor(() => jsonResponse({ supported: false }));

    const res = await getSessionPending(client, "c", "s");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.pending).toBeNull();
      expect(res.data.supported).toBe(false);
    }
  });

  it("returns a failure on a non-2xx response", async () => {
    const { client } = clientFor(() =>
      problemResponse({ type: "urn:x", title: "Not Found", status: 404 }, { status: 404 }),
    );

    const res = await getSessionPending(client, "c", "s");

    expect(res.ok).toBe(false);
  });
});

describe("respond", () => {
  it("POSTs the full body with the anti-CSRF header", async () => {
    const { client, calls } = clientFor(ACCEPTED);

    const res = await respond(client, "blackrim-hq", "sess-1", {
      action: "allow",
      text: "go ahead",
      requestId: "r1",
      metadata: { reason: "trusted" },
    });

    expect(res.ok).toBe(true);
    const call = calls[0];
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe("/v0/city/blackrim-hq/session/sess-1/respond");
    expect(call.headers.get("x-gc-request")).toBeTruthy();
    expect(await call.json()).toEqual({
      action: "allow",
      text: "go ahead",
      request_id: "r1",
      metadata: { reason: "trusted" },
    });
  });

  it("trims the action and omits unset optional fields", async () => {
    const { client, calls } = clientFor(ACCEPTED);

    await respond(client, "c", "s", { action: "  deny  " });

    expect(await calls[0].json()).toEqual({ action: "deny" });
  });

  it("rejects an empty action client-side without issuing a request", async () => {
    const { client, calls } = clientFor(ACCEPTED);

    const res = await respond(client, "c", "s", { action: "   " });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.status).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("returns a failure on a non-2xx response", async () => {
    const { client } = clientFor(() =>
      problemResponse({ type: "urn:x", title: "Conflict", status: 409 }, { status: 409 }),
    );

    const res = await respond(client, "c", "s", { action: "allow" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.status).toBe(409);
  });
});

describe("approve / deny", () => {
  it("approve sends the conventional allow action and forwards requestId", async () => {
    const { client, calls } = clientFor(ACCEPTED);

    await approve(client, "c", "s", { requestId: "r1" });

    expect(await calls[0].json()).toEqual({ action: RESPOND_ACTION_ALLOW, request_id: "r1" });
  });

  it("deny sends the conventional deny action", async () => {
    const { client, calls } = clientFor(ACCEPTED);

    await deny(client, "c", "s");

    expect(await calls[0].json()).toEqual({ action: RESPOND_ACTION_DENY });
  });

  it("honours an action override for non-standard provider vocabularies", async () => {
    const { client, calls } = clientFor(ACCEPTED);

    await approve(client, "c", "s", { action: "allow-always" });

    expect(await calls[0].json()).toEqual({ action: "allow-always" });
  });
});

describe("setPermissionMode", () => {
  it("POSTs permission_mode with the anti-CSRF header", async () => {
    const { client, calls } = clientFor(() => jsonResponse({ id: "sess-1", attached: true }));

    const res = await setPermissionMode(client, "blackrim-hq", "sess-1", "plan");

    expect(res.ok).toBe(true);
    const call = calls[0];
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe("/v0/city/blackrim-hq/session/sess-1/permission-mode");
    expect(call.headers.get("x-gc-request")).toBeTruthy();
    expect(await call.json()).toEqual({ permission_mode: "plan" });
  });

  it("trims the mode and rejects an empty one without a request", async () => {
    const { client, calls } = clientFor(() => jsonResponse({ id: "sess-1", attached: true }));

    const res = await setPermissionMode(client, "c", "s", "  ");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.status).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("returns a failure on a non-2xx response", async () => {
    const { client } = clientFor(() =>
      problemResponse({ type: "urn:x", title: "Bad Request", status: 400 }, { status: 400 }),
    );

    const res = await setPermissionMode(client, "c", "s", "plan");

    expect(res.ok).toBe(false);
  });
});

describe("kind classification", () => {
  it("identifies tool-approval and prompt-for-input", () => {
    expect(isToolApproval({ kind: PENDING_KIND_TOOL_APPROVAL })).toBe(true);
    expect(isToolApproval({ kind: PENDING_KIND_PROMPT_FOR_INPUT })).toBe(false);
    expect(isPromptForInput({ kind: PENDING_KIND_PROMPT_FOR_INPUT })).toBe(true);
    expect(isPromptForInput({ kind: PENDING_KIND_TOOL_APPROVAL })).toBe(false);
  });
});
