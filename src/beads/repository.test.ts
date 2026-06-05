import { describe, expect, it } from "vitest";
import { createCockpitClient } from "../api/client";
import { jsonResponse, mockFetch, problemResponse } from "../test/helpers";
import { BeadsApiError, BeadsRepository } from "./repository";
import { makeBead } from "./fixtures";
import type { CockpitClient } from "../api/client";

type Handler = (pathname: string, req: Request) => Response;

function repoWith(handler: Handler, client: () => CockpitClient | null = defaultClient(handler)): BeadsRepository {
  return new BeadsRepository({ getClient: client });
}

function defaultClient(handler: Handler): () => CockpitClient {
  const { fetch } = mockFetch((req) => handler(new URL(req.url).pathname, req));
  const client = createCockpitClient({ baseUrl: "http://api.test", fetch });
  return () => client;
}

describe("listCities", () => {
  it("returns the cities array", async () => {
    const repo = repoWith((p) => {
      if (p === "/v0/cities") {
        return jsonResponse({
          items: [{ name: "alpha", path: "/a", running: true }],
          total: 1,
        });
      }
      return jsonResponse({});
    });
    expect((await repo.listCities()).map((c) => c.name)).toEqual(["alpha"]);
  });

  it("raises a BeadsApiError when no client is connected", async () => {
    const repo = repoWith(() => jsonResponse({}), () => null);
    await expect(repo.listCities()).rejects.toBeInstanceOf(BeadsApiError);
    await expect(repo.listCities()).rejects.toMatchObject({ normalized: { title: "API unavailable" } });
  });
});

describe("loadCityRecords", () => {
  function handler(p: string): Response {
    if (p === "/v0/city/alpha/beads/ready") {
      return jsonResponse({ items: [makeBead({ id: "a" })], total: 1 });
    }
    if (p === "/v0/city/alpha/beads") {
      return jsonResponse({
        items: [makeBead({ id: "a", status: "open" }), makeBead({ id: "b", status: "open" })],
        total: 2,
        partial: true,
      });
    }
    return jsonResponse({});
  }

  it("marks readiness from the /beads/ready intersection and surfaces partial", async () => {
    const result = await repoWith(handler).loadCityRecords("alpha");
    expect(result.partial).toBe(true);
    expect(result.records.find((r) => r.bead.id === "a")!.ready).toBe(true);
    expect(result.records.find((r) => r.bead.id === "b")!.ready).toBe(false);
  });

  it("leaves readiness unknown (null) when /beads/ready is unavailable", async () => {
    const repo = repoWith((p) => {
      if (p === "/v0/city/alpha/beads/ready") return problemResponse({ title: "boom" }, { status: 500 });
      if (p === "/v0/city/alpha/beads") return jsonResponse({ items: [makeBead({ id: "a" })], total: 1 });
      return jsonResponse({});
    });
    const result = await repo.loadCityRecords("alpha");
    expect(result.records[0].ready).toBeNull();
  });
});

describe("loadExplorer", () => {
  function handler(p: string): Response {
    if (p === "/v0/cities") {
      return jsonResponse({
        items: [
          { name: "alpha", path: "/a", running: true },
          { name: "beta", path: "/b", running: false },
          { name: "gamma", path: "/g", running: true },
        ],
        total: 3,
      });
    }
    if (p === "/v0/city/alpha/beads") return jsonResponse({ items: [makeBead({ id: "a" })], total: 1 });
    if (p === "/v0/city/alpha/beads/ready") return jsonResponse({ items: [], total: 0 });
    if (p === "/v0/city/gamma/beads") {
      return problemResponse(
        { type: "urn:gascity:error:internal", title: "Internal Error", status: 500 },
        { status: 500 },
      );
    }
    return jsonResponse({ items: [], total: 0 });
  }

  it("fans out over running cities, isolates failures, and skips stopped cities", async () => {
    const data = await repoWith(handler).loadExplorer();
    const byCity = Object.fromEntries(data.cities.map((c) => [c.city, c]));

    expect(byCity.alpha.records.map((r) => r.bead.id)).toEqual(["a"]);
    expect(byCity.beta).toMatchObject({ running: false, records: [] });
    expect(byCity.beta.error).toBeUndefined();
    expect(byCity.gamma.error).toContain("Internal Error");
    expect(byCity.gamma.records).toEqual([]);
  });
});

describe("getBead / getBeadGraph", () => {
  it("fetches a single bead", async () => {
    const repo = repoWith((p) =>
      p === "/v0/city/alpha/bead/x" ? jsonResponse(makeBead({ id: "x", title: "X" })) : jsonResponse({}),
    );
    expect((await repo.getBead("alpha", "x")).title).toBe("X");
  });

  it("fetches a dependency graph", async () => {
    const root = makeBead({ id: "root" });
    const repo = repoWith((p) =>
      p === "/v0/city/alpha/beads/graph/root"
        ? jsonResponse({ root, beads: [root], deps: [] })
        : jsonResponse({}),
    );
    expect((await repo.getBeadGraph("alpha", "root")).root.id).toBe("root");
  });

  it("maps a 404 into a BeadsApiError carrying the status", async () => {
    const repo = repoWith((p) =>
      p === "/v0/city/alpha/bead/missing"
        ? problemResponse({ type: "urn:gascity:error:not-found", title: "Not Found", status: 404 }, { status: 404 })
        : jsonResponse({}),
    );
    await expect(repo.getBead("alpha", "missing")).rejects.toMatchObject({ normalized: { status: 404 } });
  });
});
