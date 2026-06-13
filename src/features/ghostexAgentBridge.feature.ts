/**
 * Ghostex agents-bridge feature: register the commands that launch a gas-city
 * bead's agent INTO a Ghostex pane (`gx create-agent`, deriving agent/project/cwd
 * from the bead's worktree) and reveal a previously-linked session.
 *
 * All testable logic lives in the `vscode`-free core
 * (`../ghostex/agentBridge.ts`); the editor glue — discovery, the live client,
 * reading the tree node, messages — is in `../views/ghostexAgentBridge.ts`. This
 * feature is just the registration seam, kept appendable so it merges in parallel
 * with the other Ghostex features (the explorer, the drive commands).
 */
import { registerGhostexAgentBridge } from '../views/ghostexAgentBridge.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const ghostexAgentBridgeFeature: CockpitFeature = {
  id: 'ghostexAgentBridge',
  activate(host: FeatureHost): void {
    registerGhostexAgentBridge(host);
  },
};

export default ghostexAgentBridgeFeature;
