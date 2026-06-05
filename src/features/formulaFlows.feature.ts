/**
 * Formula flows feature: preview a formula, watch its runs, and kick off the
 * `tdd` formula on a bead. Talks to the currently-connected supervisor through
 * the host's live client.
 */
import { registerFormulaFlows } from '../views/formulaFlows.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const formulaFlowsFeature: CockpitFeature = {
  id: 'formulaFlows',
  activate(host: FeatureHost): void {
    registerFormulaFlows(host.context, {
      getClient: () => host.getClient(),
      repository: host.repository,
      log: host.log,
    });
  },
};

export default formulaFlowsFeature;
