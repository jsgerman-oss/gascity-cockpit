import { describe, expect, it } from "vitest";
import { createCockpitClient } from "./client";
import {
  BeadsClient,
  CSRF_HEADER_VALUE,
  ROUTED_TO_KEY,
  type Bead,
  type BeadDeps,
  type SlingResult,
} from "./beads";
import { jsonResponse, mockFetch, problemResponse } from "../test/helpers";

const CITY = "blackrim-hq";

/** Build a BeadsClient wired to a mock fetch, exposing the recorded requests. */
function setup(handler: (req: Request) => Response | Promise<Response>) {
  const { fetch, calls } = mockFetch(handler);
  const client = createCockpitClient({ baseUrl: "http://api.test", fetch });
  return { beads: new BeadsClient(client, CITY), calls };
}

/** A minimal OK acknowledgement body, as update/close/reopen return. */
const OK = { status: "ok" };

/** Read the JSON body of a recorded request without disturbing the original. */
async function body(req: Request): Promise<unknown> {
  return req.clone().json();
}

describe("BeadsClient.create", () => {
  it("POSTs to /beads with the title body and CSRF header, returning the bead", async () => {
    const created: Bead = {
      id: "blackrim-hq.42",
      title: "New work",
      status: "open",
      issue_type: "task",
      created_at: "2026-06-05T00:00:00Z",
    };
    const { beads, calls } = setup(() => jsonResponse(created, { status: 201 }));

    const result = await beads.create({ title: "New work", priority: 2 });

    expect(result).toEqual({ ok: true, data: created });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/beads`);
    expect(calls[0].headers.get("x-gc-request")).toBe(CSRF_HEADER_VALUE);
    expect(await body(calls[0])).toEqual({ title: "New work", priority: 2 });
  });
});

describe("BeadsClient.update", () => {
  it("POSTs the patch to /bead/{id}/update with the CSRF header", async () => {
    const { beads, calls } = setup(() => jsonResponse(OK));

    const result = await beads.update("blackrim-hq.42", { title: "Renamed", priority: 1 });

    expect(result).toEqual({ ok: true, data: OK });
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/bead/blackrim-hq.42/update`);
    expect(calls[0].headers.get("x-gc-request")).toBe(CSRF_HEADER_VALUE);
    expect(await body(calls[0])).toEqual({ title: "Renamed", priority: 1 });
  });

  it("url-encodes the bead id in the path", async () => {
    const { beads, calls } = setup(() => jsonResponse(OK));
    await beads.update("rig/with space", { status: "open" });
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/bead/rig%2Fwith%20space/update`);
  });
});

describe("BeadsClient.close / reopen", () => {
  it("POSTs to /close with the CSRF header and no body", async () => {
    const { beads, calls } = setup(() => jsonResponse(OK));

    const result = await beads.close("blackrim-hq.42");

    expect(result).toEqual({ ok: true, data: OK });
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/bead/blackrim-hq.42/close`);
    expect(calls[0].headers.get("x-gc-request")).toBe(CSRF_HEADER_VALUE);
    expect(calls[0].body).toBeNull();
  });

  it("POSTs to /reopen", async () => {
    const { beads, calls } = setup(() => jsonResponse(OK));
    await beads.reopen("blackrim-hq.42");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/bead/blackrim-hq.42/reopen`);
    expect(calls[0].headers.get("x-gc-request")).toBe(CSRF_HEADER_VALUE);
  });
});

describe("BeadsClient.assign / unassign", () => {
  it("POSTs the assignee to /assign and returns the ack", async () => {
    const ack = { assignee: "gascity-cockpit/gastown.polecat" };
    const { beads, calls } = setup(() => jsonResponse(ack));

    const result = await beads.assign("blackrim-hq.42", "gascity-cockpit/gastown.polecat");

    expect(result).toEqual({ ok: true, data: ack });
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/bead/blackrim-hq.42/assign`);
    expect(calls[0].headers.get("x-gc-request")).toBe(CSRF_HEADER_VALUE);
    expect(await body(calls[0])).toEqual({ assignee: "gascity-cockpit/gastown.polecat" });
  });

  it("unassign sends an empty assignee", async () => {
    const { beads, calls } = setup(() => jsonResponse({ assignee: "" }));
    await beads.unassign("blackrim-hq.42");
    expect(await body(calls[0])).toEqual({ assignee: "" });
  });
});

describe("BeadsClient.deps", () => {
  it("GETs /deps (no CSRF header) and returns the dependent child beads", async () => {
    const deps: BeadDeps = {
      children: [
        {
          id: "blackrim-hq.7",
          title: "Blocked child",
          status: "open",
          issue_type: "task",
          created_at: "2026-06-05T00:00:00Z",
        },
      ],
    };
    const { beads, calls } = setup(() => jsonResponse(deps));

    const result = await beads.deps("blackrim-hq.42");

    expect(result).toEqual({ ok: true, data: deps });
    expect(calls[0].method).toBe("GET");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/bead/blackrim-hq.42/deps`);
    expect(calls[0].headers.get("x-gc-request")).toBeNull();
  });
});

describe("BeadsClient.setParent / clearParent", () => {
  it("setParent updates the parent field", async () => {
    const { beads, calls } = setup(() => jsonResponse(OK));
    await beads.setParent("blackrim-hq.42", "blackrim-hq.1");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/bead/blackrim-hq.42/update`);
    expect(await body(calls[0])).toEqual({ parent: "blackrim-hq.1" });
  });

  it("clearParent sends a null parent to detach", async () => {
    const { beads, calls } = setup(() => jsonResponse(OK));
    await beads.clearParent("blackrim-hq.42");
    expect(await body(calls[0])).toEqual({ parent: null });
  });
});

describe("BeadsClient.route", () => {
  it("dispatches by setting gc.routed_to metadata via update", async () => {
    const { beads, calls } = setup(() => jsonResponse(OK));

    const result = await beads.route("blackrim-hq.42", "gascity-cockpit/gastown.polecat");

    expect(result).toEqual({ ok: true, data: OK });
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/bead/blackrim-hq.42/update`);
    expect(await body(calls[0])).toEqual({
      metadata: { [ROUTED_TO_KEY]: "gascity-cockpit/gastown.polecat" },
    });
  });
});

describe("BeadsClient.sling", () => {
  it("POSTs to /sling with the dispatch body and returns the sling response", async () => {
    const slingResult: SlingResult = {
      status: "ok",
      target: "gascity-cockpit/gastown.polecat",
      bead: "blackrim-hq.42",
    };
    const { beads, calls } = setup(() => jsonResponse(slingResult));

    const result = await beads.sling({
      bead: "blackrim-hq.42",
      target: "gascity-cockpit/gastown.polecat",
    });

    expect(result).toEqual({ ok: true, data: slingResult });
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe(`/v0/city/${CITY}/sling`);
    expect(calls[0].headers.get("x-gc-request")).toBe(CSRF_HEADER_VALUE);
    expect(await body(calls[0])).toEqual({
      bead: "blackrim-hq.42",
      target: "gascity-cockpit/gastown.polecat",
    });
  });
});

describe("BeadsClient error handling", () => {
  it("folds an RFC 7807 problem document into ok:false with a normalized error", async () => {
    const problem = {
      type: "urn:gascity:error:bead-not-found",
      title: "Not Found",
      status: 404,
      detail: "bead blackrim-hq.999 does not exist",
    };
    const { beads } = setup(() => problemResponse(problem, { status: 404 }));

    const result = await beads.close("blackrim-hq.999");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: 404,
        title: "Not Found",
        detail: "bead blackrim-hq.999 does not exist",
      });
    }
  });

  it("carries the supervisor request id through for log correlation", async () => {
    const { beads } = setup(() =>
      problemResponse(
        { type: "urn:gascity:error:x", title: "Conflict", status: 409 },
        { status: 409, headers: { "X-GC-Request-Id": "req-789" } },
      ),
    );

    const result = await beads.reopen("blackrim-hq.42");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.requestId).toBe("req-789");
    }
  });

  it("folds a network/abort rejection into ok:false instead of throwing", async () => {
    const { beads } = setup(() => {
      throw new TypeError("fetch failed");
    });

    const result = await beads.create({ title: "x" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.title).toBe("Network error");
      expect(result.error.status).toBe(0);
    }
  });
});
