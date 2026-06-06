// Pure formatting for the fleet-status CLI: a plain data snapshot → printable
// text. No `vscode`, no Node built-ins, no I/O — the I/O shell (fleet-status.ts)
// fetches over `/v0` through the core boundary and maps the typed responses into
// these minimal shapes, so this formatter stays decoupled and unit-testable with
// plain fixtures (render.test.ts).

/** One agent's status, reduced to the fields the CLI prints. */
export interface FleetAgent {
  name: string;
  /** Lifecycle state, e.g. "running", "idle", "stopped". */
  state: string;
  running: boolean;
  /** Bead the agent is currently working, when any. */
  activeBead?: string;
  /** Short activity line the supervisor reports, when any. */
  activity?: string;
}

/** One city and the agents discovered in it. */
export interface FleetCity {
  name: string;
  running: boolean;
  /** Supervisor-reported city status, when any. */
  status?: string;
  agents: FleetAgent[];
  /** Set when this city's agents could not be listed; agents is then empty. */
  error?: string;
}

/** The whole snapshot the CLI renders. */
export interface FleetReport {
  /** The `/v0` endpoint the snapshot was read from. */
  endpoint: string;
  cities: FleetCity[];
}

function agentLine(agent: FleetAgent): string {
  const flag = agent.running ? "●" : "○";
  const detail = agent.activeBead
    ? ` — ${agent.activeBead}${agent.activity ? ` (${agent.activity})` : ""}`
    : agent.activity
      ? ` — ${agent.activity}`
      : "";
  return `    ${flag} ${agent.name}  [${agent.state}]${detail}`;
}

function cityBlock(city: FleetCity): string {
  const flag = city.running ? "●" : "○";
  const status = city.status ? ` (${city.status})` : "";
  const header = `  ${flag} ${city.name}${status}`;
  if (city.error) {
    return `${header}\n      ! ${city.error}`;
  }
  if (city.agents.length === 0) {
    return `${header}\n      (no agents)`;
  }
  return [header, ...city.agents.map(agentLine)].join("\n");
}

/**
 * Render a {@link FleetReport} as the text the CLI writes to stdout. Pure and
 * deterministic — given the same report it always returns the same string.
 */
export function formatFleetStatus(report: FleetReport): string {
  const cityCount = report.cities.length;
  const agentCount = report.cities.reduce((n, c) => n + c.agents.length, 0);
  const lines = [
    `GasCity fleet — ${report.endpoint}`,
    `${cityCount} ${cityCount === 1 ? "city" : "cities"}, ${agentCount} ${agentCount === 1 ? "agent" : "agents"}`,
    "",
  ];
  if (cityCount === 0) {
    lines.push("  (no cities)");
  } else {
    lines.push(report.cities.map(cityBlock).join("\n"));
  }
  return lines.join("\n");
}
