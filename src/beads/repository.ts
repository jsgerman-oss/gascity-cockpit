// Data access for the Beads explorer.
//
// Wraps the typed /v0 client (Seam 1) with the four bead endpoints the explorer
// needs — `/cities`, `/beads`, `/beads/ready`, `/bead/{id}`, `/beads/graph` —
// and fans out across every running city. City-level failures are isolated so
// one unreachable city never blanks the whole tree. No `vscode` here: tests
// drive it with a mock-fetch client exactly like `api/client.test.ts`.
import type { CockpitClient } from "../api/client.ts";
import { normalizeError, type NormalizedError } from "../api/client.ts";
import type { Bead, BeadGraphResponse, BeadRecord, CityInfo, CityRecords, ExplorerData } from "./types.ts";

/** Raised for any /v0 bead call that fails; carries the normalised error. */
export class BeadsApiError extends Error {
  constructor(public readonly normalized: NormalizedError) {
    super(normalized.detail ? `${normalized.title}: ${normalized.detail}` : normalized.title);
    this.name = "BeadsApiError";
  }
}

export interface BeadsRepositoryDeps {
  /** Returns the client for the currently-connected supervisor, or null. */
  getClient: () => CockpitClient | null;
}

export interface LoadOptions {
  /** Include closed beads (maps to the `all` query param). */
  includeClosed?: boolean;
  /** Max beads per city; 0/undefined uses the server default. */
  limit?: number;
}

interface CallResult<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

export class BeadsRepository {
  constructor(private readonly deps: BeadsRepositoryDeps) {}

  private client(): CockpitClient {
    const client = this.deps.getClient();
    if (!client) {
      throw new BeadsApiError({
        status: 0,
        title: "API unavailable",
        detail: "Not connected to a supervisor API.",
      });
    }
    return client;
  }

  /** All cities the supervisor knows about. */
  async listCities(): Promise<CityInfo[]> {
    const body = await this.call(() => this.client().GET("/v0/cities"));
    return body.items ?? [];
  }

  /** Load and readiness-mark the beads for a single city. */
  async loadCityRecords(city: string, opts: LoadOptions = {}): Promise<CityRecords> {
    const query: { all: boolean; limit?: number } = { all: opts.includeClosed ?? false };
    if (opts.limit && opts.limit > 0) query.limit = opts.limit;

    const body = await this.call(() =>
      this.client().GET("/v0/city/{cityName}/beads", {
        params: { path: { cityName: city }, query },
      }),
    );

    const readySet = await this.loadReadyIds(city);
    const beads = body.items ?? [];
    const records: BeadRecord[] = beads.map((bead) => ({
      city,
      bead,
      ready: readySet ? readySet.has(bead.id) : null,
    }));

    return { city, running: true, records, partial: body.partial ?? false };
  }

  /**
   * Fan out across every city. Running cities are fetched in parallel; stopped
   * cities surface as empty placeholders (they serve no beads). A failure in one
   * city is captured as `error` on that city rather than rejecting the whole
   * load.
   */
  async loadExplorer(opts: LoadOptions = {}): Promise<ExplorerData> {
    const cities = await this.listCities();
    const settled = await Promise.allSettled(
      cities.map((c) => (c.running ? this.loadCityRecords(c.name, opts) : Promise.resolve(stoppedCity(c.name)))),
    );

    const out: CityRecords[] = cities.map((c, i) => {
      const result = settled[i];
      if (result.status === "fulfilled") return result.value;
      const normalized =
        result.reason instanceof BeadsApiError ? result.reason.normalized : normalizeError(result.reason);
      return {
        city: c.name,
        running: c.running,
        records: [],
        partial: false,
        error: normalized.detail ? `${normalized.title}: ${normalized.detail}` : normalized.title,
      };
    });

    return { cities: out };
  }

  /** Full detail for a single bead. */
  async getBead(city: string, id: string): Promise<Bead> {
    return this.call(() =>
      this.client().GET("/v0/city/{cityName}/bead/{id}", {
        params: { path: { cityName: city, id } },
      }),
    );
  }

  /** Dependency graph rooted at a bead. */
  async getBeadGraph(city: string, rootId: string): Promise<BeadGraphResponse> {
    return this.call(() =>
      this.client().GET("/v0/city/{cityName}/beads/graph/{rootID}", {
        params: { path: { cityName: city, rootID: rootId } },
      }),
    );
  }

  /** Readiness id set for a city, or null when the lookup is unavailable. */
  private async loadReadyIds(city: string): Promise<Set<string> | null> {
    try {
      const res = await this.client().GET("/v0/city/{cityName}/beads/ready", {
        params: { path: { cityName: city } },
      });
      if (res.error !== undefined || !res.data) return null;
      return new Set((res.data.items ?? []).map((b) => b.id));
    } catch {
      // Readiness is an enrichment, never a hard dependency of the explorer.
      return null;
    }
  }

  /** Await a client call and unwrap it, normalising every failure mode. */
  private async call<T>(fn: () => Promise<CallResult<T>>): Promise<T> {
    let res: CallResult<T>;
    try {
      res = await fn();
    } catch (thrown) {
      // A no-client BeadsApiError (thrown by `client()`) already carries the
      // clearest message — keep it rather than flattening it to "Network error".
      if (thrown instanceof BeadsApiError) throw thrown;
      // openapi-fetch lets network/abort rejections propagate; map them too.
      throw new BeadsApiError(normalizeError(thrown));
    }
    if (res.error !== undefined || res.data === undefined) {
      throw new BeadsApiError(normalizeError(res.error, res.response));
    }
    return res.data;
  }
}

function stoppedCity(city: string): CityRecords {
  return { city, running: false, records: [], partial: false };
}
