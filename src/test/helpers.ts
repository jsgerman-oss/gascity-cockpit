// Shared helpers for the Seam 1 client tests. Not a test file itself
// (vitest only collects *.test.ts), so it can be imported freely.

export interface MockFetch {
  /** Drop-in replacement for the global fetch. */
  fetch: typeof fetch;
  /** Clones of every request the client issued, in order. */
  calls: Request[];
}

/**
 * Build a fetch that records each request and returns whatever `handler`
 * produces. This is how the typed client is driven against a mock /v0 server
 * without real sockets (PRD Testing Decisions, Seam 1).
 */
export function mockFetch(
  handler: (req: Request) => Response | Promise<Response>,
): MockFetch {
  const calls: Request[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    return handler(req);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** Build an `application/json` Response. */
export function jsonResponse(
  body: unknown,
  { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Build an RFC 7807 `application/problem+json` error Response. */
export function problemResponse(
  body: unknown,
  { status = 500, headers = {} }: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

/** Build a ReadableStream that emits the given chunks then closes. */
export function streamFromChunks(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue = chunks.map((c) => (typeof c === "string" ? encoder.encode(c) : c));
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < queue.length) {
        controller.enqueue(queue[i++]);
      } else {
        controller.close();
      }
    },
  });
}

/** Drain an async iterable into an array. */
export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}
