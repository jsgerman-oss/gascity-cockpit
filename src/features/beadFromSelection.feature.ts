/**
 * "New bead from selection" feature (cockpit-21l.4): right-click a code
 * selection to open a new bead with the file:line context auto-attached. Talks to
 * the connected supervisor through the host's live client and is stateless across
 * connection changes, so it only needs `getClient` and the shared logger.
 */
import { registerNewBeadFromSelection } from '../views/newBeadFromSelection.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const beadFromSelectionFeature: CockpitFeature = {
  id: 'beadFromSelection',
  activate(host: FeatureHost): void {
    registerNewBeadFromSelection(host.context, {
      getClient: () => host.getClient(),
      log: host.log,
    });
  },
};

export default beadFromSelectionFeature;
