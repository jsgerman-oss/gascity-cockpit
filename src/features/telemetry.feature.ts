/**
 * Cost & tier telemetry feature: a "By Agent / By Bead" pane fed by a
 * `vscode`-free store that accumulates `worker.operation` events from the
 * supervisor SSE feed (cockpit-21l.3).
 *
 * Owns the store/live pair and connects the telemetry stream only to a
 * fully-connected supervisor — reconnecting on a detected restart or
 * endpoint/token change and tearing down when the API goes away. `liveKey`
 * dedupes the connected endpoint so routine health polls don't churn the stream.
 * Mirrors the live status feature; see docs/cost-tier-telemetry.md for the /v0
 * contract this binds to and the upstream gap it cannot yet fill.
 */
import { bearerAuthHeader } from '../api/index.ts';
import {
  LiveTelemetry,
  TelemetryStore,
  TelemetryStream,
  type TelemetryEndpoint,
} from '../telemetry/index.ts';
import { registerTelemetryViews } from '../views/telemetry.ts';
import type { ConnectionStatus } from '../discovery/index.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const telemetryFeature: CockpitFeature = {
  id: 'telemetry',
  activate(host: FeatureHost): void {
    const store = new TelemetryStore();
    const live = new LiveTelemetry({
      store,
      createStream: (ep) =>
        new TelemetryStream(ep.baseUrl, {
          headers: bearerAuthHeader(ep.token),
          log: host.log,
        }),
    });
    registerTelemetryViews(host.context, store);

    let liveKey: string | null = null;
    const applyTelemetry = (status: ConnectionStatus): void => {
      const ep = status.endpoint;
      if (status.state === 'connected' && ep) {
        const key = `${ep.baseUrl}::${ep.token ?? ''}`;
        if (status.restarted || key !== liveKey) {
          liveKey = key;
          const endpoint: TelemetryEndpoint = {
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
      host.onStatusChange(applyTelemetry),
      {
        dispose: () => {
          live.dispose();
          store.dispose();
        },
      },
    );
  },
};

export default telemetryFeature;
