/**
 * Live town-topology feature (cockpit-21l.5): a webview graph of
 * controller → city → rigs → polecats/witness/refinery, coloured by health.
 *
 * Reuses the status feature's live-data engine — a `vscode`-free
 * `FleetStatusStore` fed by `LiveStatus` (typed-client snapshots + the
 * supervisor SSE feed) — but keeps its own instance so the two features stay
 * independent and parallel-mergeable. To avoid a second always-on SSE stream,
 * it streams **only while the panel is open**: opening connects to the current
 * supervisor, closing disconnects, and a restart/endpoint change while open
 * reconnects (`liveKey` dedupes routine health polls).
 */
import { bearerAuthHeader } from '../api/index.ts';
import {
  FleetStatusStore,
  LiveStatus,
  SupervisorEventStream,
  type StatusEndpoint,
} from '../status/index.ts';
import { registerTownTopology } from '../views/townTopology.ts';
import type { ConnectionStatus } from '../discovery/index.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

function endpointOf(status: ConnectionStatus): StatusEndpoint | null {
  const ep = status.endpoint;
  if (status.state !== 'connected' || !ep) return null;
  return { baseUrl: ep.baseUrl, ...(ep.token ? { token: ep.token } : {}) };
}

const townTopologyFeature: CockpitFeature = {
  id: 'townTopology',
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

    let panelOpen = false;
    let liveKey: string | null = null;
    let endpoint: StatusEndpoint | null = null;

    const connectIfPossible = (restarted: boolean): void => {
      if (!panelOpen || !endpoint) return;
      const key = `${endpoint.baseUrl}::${endpoint.token ?? ''}`;
      if (restarted || key !== liveKey) {
        liveKey = key;
        live.connect(endpoint);
      }
    };

    const applyStatus = (status: ConnectionStatus): void => {
      endpoint = endpointOf(status);
      if (endpoint) {
        connectIfPossible(status.restarted);
      } else if (status.state === 'unavailable' || status.state === 'idle') {
        liveKey = null;
        live.disconnect();
        if (status.state === 'unavailable') store.clearSnapshot('Supervisor API unavailable');
      }
    };

    registerTownTopology(host.context, {
      store,
      onActivate: () => {
        panelOpen = true;
        liveKey = null;
        // Seed from the current connection in case it settled before the panel opened.
        endpoint = endpointOf(host.getStatus());
        connectIfPossible(true);
      },
      onDeactivate: () => {
        panelOpen = false;
        liveKey = null;
        live.disconnect();
      },
      log: host.log,
    });

    host.context.subscriptions.push(host.onStatusChange(applyStatus), {
      dispose: () => {
        live.dispose();
        store.dispose();
      },
    });
  },
};

export default townTopologyFeature;
