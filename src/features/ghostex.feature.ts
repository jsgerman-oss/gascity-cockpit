/**
 * Ghostex feature: the foundation scaffold for driving Ghostex (the native
 * macOS app exposing the `gx` CLI and the `gxserver` RPC daemon) from inside the
 * Cockpit. It registers the "Ghostex" view container + a placeholder sessions
 * tree and the `gascityCockpit.ghostex.*` commands (see
 * `ghostex.contributes.json`), and probes gxserver once on activation so the
 * tree reflects reachability immediately.
 *
 * gxserver is discovered independently of the gascity supervisor (different
 * daemon, different port/token), so this feature does its own probe on
 * activation rather than only reacting to supervisor status. It still listens to
 * `host.onStatusChange` and re-probes on the first connect / a supervisor
 * restart — both are good moments to re-check the local Ghostex daemon — keeping
 * the foundation honest about the host contract for the session/board features
 * that build on it.
 */
import { registerGhostexView } from '../views/ghostex.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const ghostexFeature: CockpitFeature = {
  id: 'ghostex',
  activate(host: FeatureHost): void {
    const view = registerGhostexView(host);

    // Probe gxserver once on activation so the placeholder tree is meaningful
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
