// Launch server for the web companion. Two jobs, zero dependencies:
//
//   1. Serve the static bundle in dist/companion/.
//   2. Reverse-proxy `/health` and `/v0/*` (including the `/v0/events/stream`
//      SSE feed) to the local supervisor.
//
// Why proxy rather than point the browser straight at the supervisor: a browser
// app on its own origin calling `:8372` is a cross-origin request, and the
// supervisor does not yet send CORS headers (the companion-surfaces spike's
// Phase-3 server-side gap, docs/companion-surfaces.md). Serving the bundle and
// the API from one origin makes every `/v0` call same-origin, so this slice runs
// end-to-end on localhost today without that server-side work — the companion's
// `resolveEndpoint` defaults its base URL to the page origin. When the supervisor
// speaks CORS, the app can talk to it directly via `?endpoint=`.
//
// Localhost-only by design (binds 127.0.0.1): this is the local-supervisor
// surface; real auth + TLS gate any remote deployment (docs/remote-and-auth.md).
import http from "node:http";
import https from "node:https";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const DEFAULTS = {
  port: 4180,
  supervisor: "http://127.0.0.1:8372",
  dir: resolve(process.cwd(), "dist/companion"),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/** Parse `--key=value` / `--key value` flags over the defaults. */
function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.replace(/^--/, "") : arg.slice(2, eq);
    const value = eq === -1 ? argv[(i += 1)] : arg.slice(eq + 1);
    if (key === "port") opts.port = Number(value);
    else if (key === "supervisor") opts.supervisor = value;
    else if (key === "dir") opts.dir = resolve(value);
  }
  return opts;
}

/** True for the paths the companion reads from `/v0` (and the health probe). */
function isApiPath(pathname) {
  return pathname === "/health" || pathname.startsWith("/v0/") || pathname === "/v0";
}

// Hop-by-hop headers are per-connection and must NOT be forwarded by a proxy
// (RFC 2616 §13.5.1) — each side manages its own. Forwarding the browser's
// `Connection: keep-alive` to the supervisor also stalls larger `/v0` responses,
// so stripping them is what keeps the proxy fast too. Node re-adds per hop.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function withoutHopByHop(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

/** Stream a proxied request through to the supervisor, piping the response back verbatim. */
function proxy(req, res, supervisor) {
  const target = new URL(req.url, supervisor);
  const driver = target.protocol === "https:" ? https : http;
  const headers = { ...withoutHopByHop(req.headers), host: target.host };

  const upstream = driver.request(target, { method: req.method, headers }, (proxyRes) => {
    // Pipe status + headers + body straight through. For the SSE stream this
    // forwards each event chunk as it arrives (no Content-Length, no buffering).
    res.writeHead(proxyRes.statusCode ?? 502, withoutHopByHop(proxyRes.headers));
    proxyRes.pipe(res);
  });

  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`companion: supervisor unreachable at ${supervisor} — ${err.message}\n`);
  });

  // If the browser disconnects before the response finishes — most importantly,
  // when it closes an open SSE stream — tear down the upstream call so we don't
  // leak it to the supervisor. Guarding on `writableEnded` avoids destroying a
  // request that already completed normally (a bodyless GET closes eagerly).
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
}

/** Serve a file from the bundle dir, guarding against path traversal. */
async function serveStatic(req, res, dir) {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(dir, relative);
  if (!filePath.startsWith(dir + sep) && filePath !== dir) {
    res.writeHead(403).end("forbidden");
    return;
  }

  let info;
  try {
    info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = join(filePath, "index.html");
      info = await stat(filePath);
    }
  } catch {
    // A missing asset (has an extension) is a genuine 404; an extensionless
    // path is a route, so fall back to the shell.
    if (extname(filePath)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }
    filePath = join(dir, "index.html");
    try {
      await stat(filePath);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("companion bundle not found — run `npm run compile` first.\n");
      return;
    }
  }

  res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

function start(opts) {
  const supervisor = opts.supervisor.replace(/\/+$/, "");
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (isApiPath(pathname)) proxy(req, res, supervisor);
    else void serveStatic(req, res, opts.dir);
  });

  server.listen(opts.port, "127.0.0.1", () => {
    console.log(`GasCity Cockpit companion`);
    console.log(`  serving   ${opts.dir}`);
    console.log(`  proxying  /v0 → ${supervisor}`);
    console.log(`  open      http://127.0.0.1:${opts.port}/`);
  });
}

start(parseArgs(process.argv.slice(2)));
