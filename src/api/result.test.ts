import { describe, expect, it } from "vitest";
import { runApi, validationError } from "./result";
import { REQUEST_ID_HEADER } from "./client";

describe("runApi", () => {
  it("returns ok with data and the request id on success", async () => {
    const response = new Response(null, { headers: { [REQUEST_ID_HEADER]: "req-7" } });
    const result = await runApi(async () => ({ data: { value: 1 }, response }));
    expect(result).toEqual({ ok: true, data: { value: 1 }, requestId: "req-7" });
  });

  it("omits requestId when the header is absent", async () => {
    const result = await runApi(async () => ({ data: { value: 1 }, response: new Response() }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.requestId).toBeUndefined();
  });

  it("maps an error body to a normalized failure", async () => {
    const response = new Response(null, { status: 404, headers: { [REQUEST_ID_HEADER]: "req-9" } });
    const result = await runApi(async () => ({
      error: { type: "urn:gascity:error:x", title: "Not Found", status: 404, detail: "missing" },
      response,
    }));
    expect(result).toEqual({
      ok: false,
      error: { status: 404, title: "Not Found", detail: "missing", requestId: "req-9", raw: expect.anything() },
    });
  });

  it("treats a missing body (no error) as a failure", async () => {
    const result = await runApi(async () => ({ response: new Response(null, { status: 204 }) }));
    expect(result.ok).toBe(false);
  });

  it("catches a thrown network/abort rejection", async () => {
    const boom = new TypeError("fetch failed");
    const result = await runApi(async () => {
      throw boom;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(0);
      expect(result.error.title).toBe("Network error");
    }
  });
});

describe("validationError", () => {
  it("builds a never-sent failure with status 0", () => {
    expect(validationError("nope")).toEqual({
      ok: false,
      error: { status: 0, title: "Invalid request", detail: "nope" },
    });
  });

  it("allows a custom title", () => {
    expect(validationError("nope", "Bad mode").error.title).toBe("Bad mode");
  });
});
