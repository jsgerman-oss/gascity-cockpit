/**
 * Beads explorer feature: the multi-city beads tree, detail documents and
 * dependency-graph webview.
 *
 * Reloads on meaningful connection transitions — first connect, a supervisor
 * restart, or the API dropping out — keying off the previous state the host
 * passes in (so routine health polls while connected don't reload the tree).
 */
import { registerBeadsExplorer } from '../views/beadsExplorer.ts';
import { connectivityOf } from '../ui/index.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const beadsFeature: CockpitFeature = {
  id: 'beads',
  activate(host: FeatureHost): void {
    const explorer = registerBeadsExplorer(host.context, { repository: host.repository });

    host.context.subscriptions.push(
      host.onStatusChange((status, prevState) => {
        // Surface the link state on every transition so a dropped supervisor
        // shows the shared reconnecting row, then reload only on the meaningful
        // transitions (first connect, restart, drop) — routine polls are silent.
        explorer.setConnectivity(connectivityOf(status.state));
        const connected = status.state === 'connected' && prevState !== 'connected';
        const dropped = status.state === 'unavailable' && prevState !== 'unavailable';
        if (connected || dropped || status.restarted) explorer.refresh();
      }),
    );
  },
};

export default beadsFeature;
