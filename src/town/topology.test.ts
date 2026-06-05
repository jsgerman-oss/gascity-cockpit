import { describe, expect, it } from 'vitest';
import { aggregateHealth, agentRole, buildTownGraph, CONTROLLER_ID } from './topology';
import type { TownGraph, TownNode } from './types';
import { makeAgent, makeCity, makeHealth, makeState } from './fixtures';

function node(graph: TownGraph, id: string): TownNode {
  const found = graph.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id} in [${graph.nodes.map((n) => n.id).join(', ')}]`);
  return found;
}

/** Parent id of `to`, via the single incoming edge (the graph is a tree). */
function parentOf(graph: TownGraph, to: string): string | undefined {
  return graph.edges.find((e) => e.to === to)?.from;
}

describe('agentRole', () => {
  it('reads the role from a qualified worker name', () => {
    expect(agentRole(makeAgent({ name: 'gastown.refinery' }))).toBe('refinery');
    expect(agentRole(makeAgent({ name: 'gascity-cockpit/gastown.witness' }))).toBe('witness');
    expect(agentRole(makeAgent({ name: 'gastown.mayor' }))).toBe('mayor');
  });

  it('falls back to the pool for an ephemeral polecat instance name', () => {
    expect(agentRole(makeAgent({ name: 'gastown.rictus', pool: 'gastown.polecat' }))).toBe('polecat');
  });

  it('returns a generic role for an unknown name with no known pool', () => {
    expect(agentRole(makeAgent({ name: 'gastown.rictus' }))).toBe('agent');
    expect(agentRole(makeAgent({ name: 'weird', pool: 'also-weird' }))).toBe('agent');
  });
});

describe('aggregateHealth', () => {
  it('lets a problem win over healthy children', () => {
    expect(aggregateHealth(['ok', 'busy', 'error'])).toBe('error');
    expect(aggregateHealth(['ok', 'warn', 'idle'])).toBe('warn');
  });

  it('prefers active work over quiet-but-healthy when nothing is wrong', () => {
    expect(aggregateHealth(['ok', 'busy', 'idle'])).toBe('busy');
    expect(aggregateHealth(['idle', 'ok'])).toBe('ok');
    expect(aggregateHealth(['idle', 'off'])).toBe('idle');
  });

  it('returns the fallback for no children', () => {
    expect(aggregateHealth([])).toBe('off');
    expect(aggregateHealth([], 'idle')).toBe('idle');
  });
});

describe('buildTownGraph — controller', () => {
  it('reflects a connected supervisor', () => {
    const graph = buildTownGraph(makeState({ health: makeHealth({ status: 'ok' }) }));
    const controller = node(graph, CONTROLLER_ID);
    expect(graph.rootId).toBe(CONTROLLER_ID);
    expect(controller.kind).toBe('controller');
    expect(controller.health).toBe('ok');
    expect(controller.sublabel).toContain('1/1 cities');
  });

  it('shows connecting while loading with no snapshot yet', () => {
    const graph = buildTownGraph(makeState({ health: null, cities: [], loading: true }));
    expect(node(graph, CONTROLLER_ID).sublabel).toBe('connecting…');
    expect(node(graph, CONTROLLER_ID).health).toBe('off');
  });

  it('shows not connected when there is no health and not loading', () => {
    const graph = buildTownGraph(makeState({ health: null, cities: [], loading: false }));
    expect(node(graph, CONTROLLER_ID).sublabel).toBe('not connected');
    expect(node(graph, CONTROLLER_ID).health).toBe('off');
  });

  it('surfaces a fatal error on the controller', () => {
    const graph = buildTownGraph(makeState({ lastError: 'snapshot failed: boom' }));
    expect(node(graph, CONTROLLER_ID).health).toBe('error');
    expect(node(graph, CONTROLLER_ID).sublabel).toBe('snapshot failed: boom');
  });
});

describe('buildTownGraph — hierarchy', () => {
  it('hangs cities off the controller, sorted by name', () => {
    const graph = buildTownGraph(
      makeState({
        cities: [makeCity({ name: 'zeta' }), makeCity({ name: 'alpha' })],
        agentsByCity: {},
      }),
    );
    const cityNodes = graph.nodes.filter((n) => n.kind === 'city').map((n) => n.label);
    expect(cityNodes).toEqual(['alpha', 'zeta']);
    expect(parentOf(graph, 'city:alpha')).toBe(CONTROLLER_ID);
    expect(parentOf(graph, 'city:zeta')).toBe(CONTROLLER_ID);
  });

  it('renders a city with no agents as a leaf city node', () => {
    const graph = buildTownGraph(makeState({ cities: [makeCity({ name: 'alpha' })], agentsByCity: {} }));
    expect(graph.nodes.filter((n) => n.kind === 'rig')).toHaveLength(0);
    expect(graph.nodes.filter((n) => n.kind === 'agent')).toHaveLength(0);
    expect(node(graph, 'city:alpha').kind).toBe('city');
  });

  it('places the mayor at town level (child of the city) as a mayor node', () => {
    const graph = buildTownGraph(
      makeState({
        cities: [makeCity({ name: 'blackrim-hq' })],
        agentsByCity: {
          'blackrim-hq': [makeAgent({ name: 'gastown.mayor', rig: undefined })],
        },
      }),
    );
    const mayor = node(graph, 'agent:blackrim-hq/gastown.mayor');
    expect(mayor.kind).toBe('mayor');
    expect(mayor.role).toBe('mayor');
    expect(parentOf(graph, mayor.id)).toBe('city:blackrim-hq');
  });

  it('treats a deacon as town-level but a plain agent node', () => {
    const graph = buildTownGraph(
      makeState({
        cities: [makeCity({ name: 'blackrim-hq' })],
        agentsByCity: { 'blackrim-hq': [makeAgent({ name: 'gastown.deacon', rig: undefined })] },
      }),
    );
    const deacon = node(graph, 'agent:blackrim-hq/gastown.deacon');
    expect(deacon.kind).toBe('agent');
    expect(deacon.role).toBe('deacon');
    expect(parentOf(graph, deacon.id)).toBe('city:blackrim-hq');
  });

  it('groups rig-scoped workers under a rig node and edges through it', () => {
    const graph = buildTownGraph(
      makeState({
        cities: [makeCity({ name: 'blackrim-hq' })],
        agentsByCity: {
          'blackrim-hq': [
            makeAgent({ name: 'gastown.refinery', rig: 'gascity-cockpit' }),
            makeAgent({ name: 'gastown.rictus', pool: 'gastown.polecat', rig: 'gascity-cockpit' }),
          ],
        },
      }),
    );
    const rigId = 'rig:blackrim-hq/gascity-cockpit';
    expect(node(graph, rigId).kind).toBe('rig');
    expect(parentOf(graph, rigId)).toBe('city:blackrim-hq');
    expect(parentOf(graph, 'agent:blackrim-hq/gastown.refinery')).toBe(rigId);
    expect(parentOf(graph, 'agent:blackrim-hq/gastown.rictus')).toBe(rigId);
    // Refinery sorts before a polecat within a rig.
    const order = graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.role);
    expect(order).toEqual(['refinery', 'polecat']);
  });

  it('falls a rig-less worker back to town level', () => {
    const graph = buildTownGraph(
      makeState({
        cities: [makeCity({ name: 'blackrim-hq' })],
        agentsByCity: { 'blackrim-hq': [makeAgent({ name: 'gastown.refinery', rig: undefined })] },
      }),
    );
    expect(graph.nodes.filter((n) => n.kind === 'rig')).toHaveLength(0);
    expect(parentOf(graph, 'agent:blackrim-hq/gastown.refinery')).toBe('city:blackrim-hq');
  });

  it('keeps every node id unique', () => {
    const graph = buildTownGraph(
      makeState({
        cities: [makeCity({ name: 'a' }), makeCity({ name: 'b' })],
        agentsByCity: {
          a: [makeAgent({ name: 'gastown.witness', rig: 'r1' }), makeAgent({ name: 'gastown.mayor', rig: undefined })],
          b: [makeAgent({ name: 'gastown.refinery', rig: 'r2' })],
        },
      }),
    );
    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildTownGraph — health', () => {
  it('colours an agent node by its status kind', () => {
    const graph = buildTownGraph(
      makeState({
        cities: [makeCity({ name: 'c' })],
        agentsByCity: {
          c: [
            makeAgent({ name: 'gastown.refinery', rig: 'r', running: true, available: true }),
            makeAgent({ name: 'gastown.witness', rig: 'r', suspended: true }),
          ],
        },
      }),
    );
    expect(node(graph, 'agent:c/gastown.refinery').health).toBe('busy');
    expect(node(graph, 'agent:c/gastown.witness').health).toBe('off');
  });

  it('aggregates the worst member health onto the rig', () => {
    const graph = buildTownGraph(
      makeState({
        cities: [makeCity({ name: 'c' })],
        agentsByCity: {
          c: [
            makeAgent({ name: 'gastown.refinery', rig: 'r', running: true }),
            makeAgent({ name: 'gastown.witness', rig: 'r', available: false }),
          ],
        },
      }),
    );
    // refinery=busy, witness=warn → rig surfaces warn.
    expect(node(graph, 'rig:c/r').health).toBe('warn');
    expect(node(graph, 'rig:c/r').sublabel).toBe('2 agents · 1 active');
  });
});
