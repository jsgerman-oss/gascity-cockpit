/**
 * Live status feature: the Fleet + Event Feed trees, fed by a `vscode`-free
 * store (snapshots from the typed client, events from the supervisor SSE feed).
 *
 * Owns the store/live pair and connects the live stream only to a fully-connected
 * supervisor — reconnecting on a detected restart or endpoint/token change and
 * tearing down when the API goes away. `liveKey` dedupes the connected endpoint
 * so routine health polls don't churn the stream.
 */
import {
  FleetStatusStore,
  LiveStatus,
  SupervisorEventStream,
  type StatusEndpoint,
} from '../status/index.ts';
import { registerStatusViews } from '../status/views.ts';
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
          ...(ep.token ? { headers: { Authorization: `Bearer ${ep.token}` } } : {}),
          log: host.log,
        }),
      log: host.log,
    });
    registerStatusViews(host.context, store, live);

    let liveKey: string | null = null;
    const applyLiveStatus = (status: ConnectionStatus): void => {
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
        if (status.state === 'unavailable') store.clearSnapshot('Supervisor API unavailable');
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
