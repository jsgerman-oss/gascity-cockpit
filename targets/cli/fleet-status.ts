// fleet-status — a stub non-extension target that prints the fleet over `/v0`.
//
// This is the proof the multi-target scaffold (cockpit-dc8.4) exists for: a
// plain Node CLI, with no `vscode` anywhere, that builds and runs by importing
// the shared **core boundary** (`src/core`) — the same typed `/v0` client and
// domain cores the VS Code extension uses. A future ACP adapter / MCP server /
// web companion follows this same shape: import core, add an esbuild target,
// ship. See docs/core-boundary.md.
//
// Usage:
//   fleet-status [endpoint] [--endpoint=URL] [--timeout=MS] [--help]
//   GASCITY_API_URL=http://host:port fleet-status
//
// Endpoint precedence: --endpoint flag → positional arg → $GASCITY_API_URL →
// the localhost supervisor default. Exits 0 on success, 1 on any failure or bad
// usage, 2 when invoked with --help.
import * as core from "../../src/core/index.ts";
import { formatFleetStatus, type FleetCity } from "./render.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

interface CliOptions {
  endpoint: string;
  timeoutMs: number;
}

const USAGE = `fleet-status — print the GasCity fleet over /v0

Usage:
  fleet-status [endpoint] [--endpoint=URL] [--timeout=MS] [--help]

Options:
  endpoint, --endpoint=URL  Supervisor base URL (default: $GASCITY_API_URL or
                            ${core.discovery.DEFAULT_SUPERVISOR_BASE_URL})
  --timeout=MS              Per-request timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  --help                    Show this help and exit`;

/** Parse argv into options, or a directive to show help / report a usage error. */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): { kind: "run"; options: CliOptions } | { kind: "help" } | { kind: "error"; message: string } {
  let endpoint: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    if (arg.startsWith("--endpoint=")) {
      endpoint = arg.slice("--endpoint=".length);
    } else if (arg.startsWith("--timeout=")) {
      const ms = Number(arg.slice("--timeout=".length));
      if (!Number.isFinite(ms) || ms < 0) {
        return { kind: "error", message: `invalid --timeout: ${arg}` };
      }
      timeoutMs = ms;
    } else if (arg.startsWith("-")) {
      return { kind: "error", message: `unknown option: ${arg}` };
    } else if (endpoint === undefined) {
      endpoint = arg;
    } else {
      return { kind: "error", message: `unexpected argument: ${arg}` };
    }
  }

  return {
    kind: "run",
    options: {
      endpoint: endpoint ?? env.GASCITY_API_URL ?? core.discovery.DEFAULT_SUPERVISOR_BASE_URL,
      timeoutMs,
    },
  };
}

/** Read the fleet snapshot over `/v0` and render it; throws on the first failure. */
async function collectFleet(options: CliOptions): Promise<string> {
  const client = core.api.createCockpitClient({
    baseUrl: options.endpoint,
    timeoutMs: options.timeoutMs,
  });

  const cities = await core.api.listCities(client);
  if (!cities.ok) {
    throw new Error(`could not list cities: ${cities.error.title}${cities.error.detail ? ` — ${cities.error.detail}` : ""}`);
  }

  const cityInfos = cities.data.items ?? [];
  const rows: FleetCity[] = await Promise.all(
    cityInfos.map(async (city): Promise<FleetCity> => {
      const agents = await core.api.runApi(() =>
        client.GET("/v0/city/{cityName}/agents", { params: { path: { cityName: city.name } } }),
      );
      if (!agents.ok) {
        return { name: city.name, running: city.running, status: city.status, agents: [], error: agents.error.title };
      }
      return {
        name: city.name,
        running: city.running,
        status: city.status,
        agents: (agents.data.items ?? []).map((agent) => ({
          name: agent.name,
          state: agent.state,
          running: agent.running,
          activeBead: agent.active_bead,
          activity: agent.activity,
        })),
      };
    }),
  );

  return formatFleetStatus({ endpoint: options.endpoint, cities: rows });
}

/** Entry point: parse, fetch, print. Returns the process exit code. */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<number> {
  const parsed = parseArgs(argv, env);
  if (parsed.kind === "help") {
    console.log(USAGE);
    return 2;
  }
  if (parsed.kind === "error") {
    console.error(`fleet-status: ${parsed.message}\n\n${USAGE}`);
    return 1;
  }
  try {
    console.log(await collectFleet(parsed.options));
    return 0;
  } catch (err) {
    console.error(`fleet-status: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
