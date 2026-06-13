/**
 * Coverage for the Ghostex agents-bridge feature seam (bead zmux-ecb31720).
 *
 * The feature is a one-liner — it registers the launch/reveal commands and wires
 * them to the host. We drive that seam against the fake host: registration +
 * disposal, the no-selection no-ops, the offline warning (no city connected), and
 * the "nothing linked yet" reveal. The launch/focus happy paths reach gxserver
 * and live in the `vscode`-bound view glue (excluded from coverage), so they are
 * not exercised here — same split as the explorer feature.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import ghostexAgentBridgeFeature from './ghostexAgentBridge.feature.ts';
import { createTestbed } from '../test/fake-host.ts';
import type { BeadTreeNode } from '../beads/index.ts';

const LAUNCH = 'gascityCockpit.ghostex.launchAgentForBead';
const REVEAL = 'gascityCockpit.ghostex.revealAgentForBead';

/** A Beads-explorer bead leaf node, as the context-menu hands the command. */
function beadNode(metadata?: Record<string, string>): BeadTreeNode {
  const bead = {
    id: 'zmux-1',
    title: 'Launch agent',
    status: 'open',
    issue_type: 'feature',
    created_at: '2026-06-13T00:00:00Z',
    ...(metadata ? { metadata } : {}),
  };
  return {
    kind: 'bead',
    id: 'bead:zmux-1',
    city: 'alpha',
    beadId: 'zmux-1',
    record: { city: 'alpha', bead, ready: true },
    displayStatus: 'open',
  };
}

afterEach(() => vi.restoreAllMocks());

describe('ghostex agents-bridge feature', () => {
  it('registers the launch + reveal commands and removes them on dispose', () => {
    const tb = createTestbed();
    tb.activate(ghostexAgentBridgeFeature);

    expect(tb.hasCommand(LAUNCH)).toBe(true);
    expect(tb.hasCommand(REVEAL)).toBe(true);
    expect(tb.subscriptions()).toHaveLength(2);

    tb.disposeAll();
    expect(tb.hasCommand(LAUNCH)).toBe(false);
    expect(tb.hasCommand(REVEAL)).toBe(false);
  });

  it('does nothing when invoked without a bead node', async () => {
    const tb = createTestbed();
    tb.activate(ghostexAgentBridgeFeature);

    await tb.invokeCommand(LAUNCH);
    await tb.invokeCommand(REVEAL);

    expect(tb.infoMessages()).toHaveLength(0);
    expect(tb.warnMessages()).toHaveLength(0);
    expect(tb.errorMessages()).toHaveLength(0);
    tb.disposeAll();
  });

  it('warns to connect a city before launching (no client → linkage cannot be saved)', async () => {
    const tb = createTestbed(); // client null by default
    tb.activate(ghostexAgentBridgeFeature);

    await tb.invokeCommand(LAUNCH, beadNode({ 'gc.provider': 'claude', repo: '/repo' }));

    expect(tb.warnMessages().map((m) => m.message)).toContain(
      'Cockpit is not connected to a city — connect first so the Ghostex linkage can be saved on the bead.',
    );
    tb.disposeAll();
  });

  it('tells the operator nothing is linked when revealing an unlinked bead', async () => {
    const tb = createTestbed();
    tb.activate(ghostexAgentBridgeFeature);

    await tb.invokeCommand(REVEAL, beadNode({ 'gc.provider': 'claude' }));

    expect(tb.infoMessages().map((m) => m.message)).toContain(
      'No Ghostex session is linked to this bead yet — run "Launch Agent in Ghostex" first.',
    );
    tb.disposeAll();
  });
});
