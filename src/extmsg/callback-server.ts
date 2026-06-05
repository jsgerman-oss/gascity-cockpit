// The Cockpit's extmsg callback service.
//
// An extmsg adapter needs a *reachable* `callback_url` the supervisor POSTs
// outbound deliveries to (pack `docs/DESIGN.md` fork #2). The Cockpit is a VS
// Code extension — a client — so to be a first-class participant it runs this
// small loopback HTTP service and advertises its URL at registration time.
//
// Security hygiene for an in-process listener:
//   - binds 127.0.0.1 only (never a routable interface);
//   - guards the route with an unguessable token segment, so only the
//     supervisor (which received the URL) can reach it — not arbitrary local
//     processes probing `/extmsg/callback`;
//   - caps the request body to bound memory from a runaway/hostile POST.
//
// `vscode`-free and unit-testable: tests start it on an ephemeral loopback port
// and drive it with real `fetch`, since the whole point is genuine reachability.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Logger } from "../discovery/index.ts";

/** A delivery the supervisor POSTed to the callback URL. */
export interface CallbackDelivery {
  /** Parsed JSON body, or the raw string when the body was not JSON. */
  body: unknown;
  /** Lower-cased request headers, for provenance / future auth. */
  headers: Record<string, string>;
}

/** Invoked for each accepted POST delivery. Must not throw to the caller. */
export type DeliveryHandler = (delivery: CallbackDelivery) => void;

/**
 * The slice of a callback service the participant depends on. Lets the durable
 * registration manager be unit-tested against a fake (controllable start
 * failure, synthetic deliveries) without binding real loopback sockets.
 */
export interface CallbackService {
  /** Reachable callback URL once started, else `null`. */
  readonly url: string | null;
  /** Delivery handler, late-bindable by the owner. */
  onDelivery: DeliveryHandler | undefined;
  /** Start listening; resolves to the reachable URL. */
  start(): Promise<string>;
  /** Stop listening. */
  stop(): Promise<void>;
}

export interface CallbackServerOptions {
  /** Bind host — defaults to loopback and should stay there. */
  host?: string;
  /** Bind port; `0` (default) picks an ephemeral free port. */
  port?: number;
  /** Route prefix before the guard token. */
  pathPrefix?: string;
  /** Guard token; defaults to a fresh random hex string. */
  token?: string;
  /** Max accepted body size in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /** Delivery handler (also settable after construction). */
  onDelivery?: DeliveryHandler;
  log?: Logger;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PATH_PREFIX = "/extmsg/callback";
const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB

export class CallbackServer implements CallbackService {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly maxBodyBytes: number;
  private readonly log: Logger;
  private readonly path: string;

  private server: Server | null = null;
  private boundPort: number | null = null;

  /** Delivery handler — late-bindable so the owner can wire it after construction. */
  onDelivery: DeliveryHandler | undefined;

  constructor(options: CallbackServerOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.requestedPort = options.port ?? 0;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.log = options.log ?? (() => {});
    this.onDelivery = options.onDelivery;
    const prefix = (options.pathPrefix ?? DEFAULT_PATH_PREFIX).replace(/\/+$/, "");
    const token = options.token ?? randomBytes(16).toString("hex");
    this.path = `${prefix}/${token}`;
  }

  /** The reachable callback URL, or `null` until {@link start} has bound a port. */
  get url(): string | null {
    if (this.boundPort === null) return null;
    return `http://${this.host}:${this.boundPort}${this.path}`;
  }

  /** The bound port, or `null` until started. */
  get port(): number | null {
    return this.boundPort;
  }

  /** Whether the service is currently listening. */
  get listening(): boolean {
    return this.server !== null && this.boundPort !== null;
  }

  /**
   * Start listening on the loopback interface. Idempotent — a second call
   * resolves to the already-bound URL. Resolves to the reachable callback URL.
   */
  start(): Promise<string> {
    if (this.server && this.boundPort !== null) {
      return Promise.resolve(this.url as string);
    }
    return new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.on("error", (err) => {
        this.server = null;
        this.boundPort = null;
        reject(err);
      });
      server.listen(this.requestedPort, this.host, () => {
        const addr = server.address() as AddressInfo | null;
        if (!addr || typeof addr === "string") {
          server.close();
          reject(new Error("callback server bound to an unexpected address"));
          return;
        }
        this.server = server;
        this.boundPort = addr.port;
        this.log("info", "extmsg callback service listening", { url: this.url as string });
        resolve(this.url as string);
      });
    });
  }

  /** Stop listening. Idempotent — safe to call when never started. */
  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (!server) return Promise.resolve();
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  /**
   * Verify the service is actually reachable by issuing a loopback GET to its
   * own URL. Returns `false` (never throws) when not started or unreachable.
   */
  async probe(fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
    const url = this.url;
    if (!url) return false;
    try {
      const res = await fetchImpl(url, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?", 1)[0];
    // Unguessable-token guard: anything but our exact route is invisible.
    if (path !== this.path) {
      this.send(res, 404, { error: "not found" });
      return;
    }
    // GET/HEAD are a liveness probe — used by the participant to self-verify
    // reachability before advertising the URL. HEAD carries no body.
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end();
      return;
    }
    if (req.method === "GET") {
      this.send(res, 200, { status: "ok", adapter: "cockpit" });
      return;
    }
    if (req.method !== "POST") {
      this.send(res, 405, { error: "method not allowed" });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > this.maxBodyBytes) {
        rejected = true;
        this.send(res, 413, { error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text; // tolerate non-JSON: surface the raw payload
        }
      }
      this.deliver({ body, headers: headerMap(req) });
      this.send(res, 200, { status: "ok" });
    });
    req.on("error", () => {
      if (!rejected) this.send(res, 400, { error: "bad request" });
    });
  }

  private deliver(delivery: CallbackDelivery): void {
    if (!this.onDelivery) return;
    try {
      this.onDelivery(delivery);
    } catch (err) {
      // A faulty handler must never take the listener down or 500 the supervisor.
      this.log("warn", "extmsg callback delivery handler threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  }
}

/** Collapse Node's header bag into a flat lower-cased string map. */
function headerMap(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
