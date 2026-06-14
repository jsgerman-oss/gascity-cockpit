/**
 * Ghostex feature: drives Ghostex (the native macOS app exposing the `gx` CLI
 * and the `gxserver` RPC daemon) from inside the Cockpit. It registers the
 * "Ghostex" view container + the Sessions explorer (projects→sessions, live
 * activity) and the `gascityCockpit.ghostex.*` commands (see
 * `ghostex.contributes.json`), and loads the gxserver snapshot once on
 * activation so the tree reflects state immediately.
 *
 * gxserver is discovered independently of the gascity supervisor (different
 * daemon, different port/token), so this feature does its own probe on
 * activation rather than only reacting to supervisor status. It still listens to
 * `host.onStatusChange` and re-probes on the first connect / a supervisor
 * restart — both are good moments to re-check the local Ghostex daemon.
 */
import { registerGhostexExplorer } from '../views/ghostexExplorer.ts';
import { registerGhostexProxy } from '../views/ghostexProxy.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const ghostexFeature: CockpitFeature = {
  id: 'ghostex',
  activate(host: FeatureHost): void {
    const view = registerGhostexExplorer(host);

    // D4b: proxy a gas-city-owned agent session into a Ghostex pane (display +
    // attach). The explorer surfaces Ghostex-hosted sessions; this surfaces the
    // reverse — a gas-city session viewable/attachable in Ghostex.
    registerGhostexProxy(host);

    // Load the gxserver snapshot once on activation so the tree is meaningful
    // before any supervisor event fires.
    void view.refresh();

    host.context.subscriptions.push(
      host.onStatusChange((status, prevState) => {
        const justConnected = status.state === 'connected' && prevState !== 'connected';
        if (justConnected || status.restarted) void view.refresh();
      }),
    );
  },
};

export default ghostexFeature;
