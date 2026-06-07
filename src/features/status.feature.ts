/**
 * Live status feature: the Fleet + Event Feed trees, fed by a `vscode`-free
 * store (snapshots from the typed client, events from the supervisor SSE feed).
 *
 * Owns the store/live pair and connects the live stream only to a fully-connected
 * supervisor — reconnecting on a detected restart or endpoint/token change and
 * tearing down when the API goes away. `liveKey` dedupes the connected endpoint
 * so routine health polls don't churn the stream.
 */
import { bearerAuthHeader } from '../api/index.ts';
import {
  FleetStatusStore,
  LiveStatus,
  SupervisorEventStream,
  type StatusEndpoint,
} from '../status/index.ts';
import { registerStatusViews } from '../status/views.ts';
import { connectivityOf } from '../ui/index.ts';
import type { ConnectionStatus } from '../discovery/index.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const statusFeature: CockpitFeature = {
  id: 'status',
  activate(host: FeatureHost): void {
    const store = new FleetStatusStore();
    const live = new LiveStatus({
      store,
      createClient: (ep) => host.createClient(ep),
      createStream: (ep) =>
        new SupervisorEventStream(ep.baseUrl, {
          headers: bearerAuthHeader(ep.token),
          log: host.log,
        }),
      log: host.log,
    });
    registerStatusViews(host.context, store, live);

    let liveKey: string | null = null;
    const applyLiveStatus = (status: ConnectionStatus): void => {
      // Forward the link state first, on every transition: a dropped supervisor
      // now degrades the Fleet/Event panes to a shared "reconnecting" row over
      // their last-known rows — rather than clearing them to a hard error — and
      // recovers on its own when the connection returns.
      store.setConnectivity(connectivityOf(status.state));
      const ep = status.endpoint;
      if (status.state === 'connected' && ep) {
        const key = `${ep.baseUrl}::${ep.token ?? ''}`;
        if (status.restarted || key !== liveKey) {
          liveKey = key;
          const endpoint: StatusEndpoint = {
            baseUrl: ep.baseUrl,
            ...(ep.token ? { token: ep.token } : {}),
          };
          live.connect(endpoint);
        }
      } else if (status.state === 'unavailable' || status.state === 'idle') {
        if (liveKey !== null) {
          liveKey = null;
          live.disconnect();
        }
      }
    };

    host.context.subscriptions.push(
      host.onStatusChange(applyLiveStatus),
      {
        dispose: () => {
          live.dispose();
          store.dispose();
        },
      },
    );
  },
};

export default statusFeature;
