// Derive the town-topology graph from a fleet snapshot (cockpit-21l.5).
//
// Pure and `vscode`-free. Turns the supervisor health + cities + per-city agents
// (the same data the Fleet tree renders) into a layered hierarchy:
//
//   Controller ─▶ City (town) ─┬─▶ Mayor / Deacon          (town-level agents)
//                              └─▶ Rig ─▶ polecat / witness / refinery / crew
//
// Health reuses the status panes' `*StatusKind` derivations, so a node here is
// the same colour it is in the Fleet tree. Structural nodes (rigs) aggregate the
// health of their members so a problem surfaces at every layer above it.
import {
  agentDescription,
  agentLabel,
  agentStatusKind,
  cityDescription,
  cityStatusKind,
  supervisorDescription,
  supervisorStatusKind,
} from '../status/index.ts';
import type { AgentResponse } from '../status/index.ts';
import type { TownEdge, TownGraph, TownHealth, TownNode, TownStateInput } from './types.ts';

export const CONTROLLER_ID = 'controller';

/** Roles the cockpit understands; everything else renders as a generic agent. */
const KNOWN_ROLES = new Set(['mayor', 'deacon', 'controller', 'witness', 'refinery', 'crew', 'polecat']);

/** Display/sort order for agent roles within a layer (lower = earlier). */
const ROLE_ORDER = ['mayor', 'deacon', 'refinery', 'witness', 'crew', 'polecat', 'agent'];

/**
 * Salience ordering for aggregating child healths onto a rig: problems
 * (error/warn) always win, then active work (busy) outranks quiet-but-healthy
 * (ok/idle), and suspended/off is the least salient. Lets a rig's colour answer
 * "is anything wrong, and is anyone working?" at a glance.
 */
const SEVERITY: Record<TownHealth, number> = { error: 6, warn: 5, busy: 4, ok: 3, idle: 2, off: 1 };

/** Build the town topology graph from the current fleet state. */
export function buildTownGraph(state: TownStateInput): TownGraph {
  const nodes: TownNode[] = [];
  const edges: TownEdge[] = [];

  nodes.push(controllerNode(state));

  // Stable left-to-right layout: cities alphabetical, agents by role then name.
  const cities = [...state.cities].sort((a, b) => a.name.localeCompare(b.name));
  for (const city of cities) {
    const cityId = `city:${city.name}`;
    nodes.push({
      id: cityId,
      kind: 'city',
      label: city.name,
      sublabel: cityDescription(city),
      health: cityStatusKind(city),
    });
    edges.push({ from: CONTROLLER_ID, to: cityId });

    const agents = state.agentsByCity[city.name] ?? [];
    const { townLevel, byRig } = partitionAgents(agents, city.name);

    // Town-level agents (mayor first) hang directly off the city, "leading" the
    // rigs — the `controller → mayor → rigs` shape from the bead.
    for (const agent of sortAgents(townLevel)) {
      const id = agentId(city.name, agent);
      const role = agentRole(agent);
      nodes.push({
        id,
        kind: role === 'mayor' ? 'mayor' : 'agent',
        label: agentLabel(agent),
        sublabel: agentDescription(agent),
        health: agentStatusKind(agent),
        role,
      });
      edges.push({ from: cityId, to: id });
    }

    // Rigs (alphabetical) and their worker agents below them.
    for (const rig of [...byRig.keys()].sort((a, b) => a.localeCompare(b))) {
      const rigAgents = byRig.get(rig)!;
      const rigId = `rig:${city.name}/${rig}`;
      nodes.push({
        id: rigId,
        kind: 'rig',
        label: rig,
        sublabel: rigSublabel(rigAgents),
        health: aggregateHealth(rigAgents.map(agentStatusKind)),
      });
      edges.push({ from: cityId, to: rigId });

      for (const agent of sortAgents(rigAgents)) {
        const id = agentId(city.name, agent);
        nodes.push({
          id,
          kind: 'agent',
          label: agentLabel(agent),
          sublabel: agentDescription(agent),
          health: agentStatusKind(agent),
          role: agentRole(agent),
        });
        edges.push({ from: rigId, to: id });
      }
    }
  }

  return { rootId: CONTROLLER_ID, nodes, edges };
}

/** The root controller node, reflecting connection/loading/error state. */
function controllerNode(state: TownStateInput): TownNode {
  const base = { id: CONTROLLER_ID, kind: 'controller' as const, label: 'Controller' };
  if (state.lastError) return { ...base, sublabel: state.lastError, health: 'error' };
  if (!state.health) {
    return { ...base, sublabel: state.loading ? 'connecting…' : 'not connected', health: 'off' };
  }
  return { ...base, sublabel: supervisorDescription(state.health), health: supervisorStatusKind(state.health) };
}

/** Split a city's agents into town-level (mayor/deacon/rig-less) and rig-grouped. */
function partitionAgents(
  agents: AgentResponse[],
  cityName: string,
): { townLevel: AgentResponse[]; byRig: Map<string, AgentResponse[]> } {
  const townLevel: AgentResponse[] = [];
  const byRig = new Map<string, AgentResponse[]>();
  for (const agent of agents) {
    if (isTownLevel(agent)) {
      townLevel.push(agent);
      continue;
    }
    const rig = agent.rig || cityName;
    const bucket = byRig.get(rig);
    if (bucket) bucket.push(agent);
    else byRig.set(rig, [agent]);
  }
  return { townLevel, byRig };
}

/** A town-level agent coordinates the whole town: mayor/deacon, or anything rig-less. */
function isTownLevel(agent: AgentResponse): boolean {
  const role = agentRole(agent);
  return role === 'mayor' || role === 'deacon' || role === 'controller' || !agent.rig;
}

/**
 * Resolve an agent's role token. Worker agents are named `<town>.<role>`
 * (`gastown.refinery`); ephemeral polecats get unique instance names
 * (`gastown.rictus`) but carry a `pool` (`gastown.polecat`) we fall back to.
 */
export function agentRole(agent: AgentResponse): string {
  const seg = lastSegment(agent.name);
  if (KNOWN_ROLES.has(seg)) return seg;
  if (agent.pool) {
    const poolSeg = lastSegment(agent.pool);
    if (KNOWN_ROLES.has(poolSeg)) return poolSeg;
  }
  return 'agent';
}

/** The final `.`/`/`-delimited segment of a qualified name. */
function lastSegment(name: string): string {
  const afterSlash = name.slice(name.lastIndexOf('/') + 1);
  return afterSlash.slice(afterSlash.lastIndexOf('.') + 1);
}

function agentId(cityName: string, agent: AgentResponse): string {
  return `agent:${cityName}/${agent.name}`;
}

/** Sort agents by role priority, then by display name, for a stable layout. */
function sortAgents(agents: AgentResponse[]): AgentResponse[] {
  return [...agents].sort((a, b) => {
    const ra = roleRank(agentRole(a));
    const rb = roleRank(agentRole(b));
    return ra - rb || agentLabel(a).localeCompare(agentLabel(b));
  });
}

function roleRank(role: string): number {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

function rigSublabel(agents: AgentResponse[]): string {
  const running = agents.filter((a) => a.running).length;
  const noun = agents.length === 1 ? 'agent' : 'agents';
  return `${agents.length} ${noun} · ${running} active`;
}

/** The most salient health among children (see {@link SEVERITY}). */
export function aggregateHealth(healths: TownHealth[], fallback: TownHealth = 'off'): TownHealth {
  if (healths.length === 0) return fallback;
  return healths.reduce((worst, h) => (SEVERITY[h] > SEVERITY[worst] ? h : worst), healths[0]);
}
