/**
 * Metrics-over-time feature: a "Metrics" pane reporting throughput, cycle time,
 * and refinery reject rate over a selectable window, broken down per rig and per
 * agent (cockpit-3x7).
 *
 * Unlike the live telemetry feed, this pane is a windowed snapshot: it reads
 * bead-lifecycle history from `/v0` on connect / refresh / window change and
 * derives the model in one pass (see `src/metrics/load.ts`). It connects only to
 * a fully-connected supervisor, reloads on a detected restart or endpoint/token
 * change, and clears when the API goes away. A `generation` token discards a
 * superseded load so a stale window can't overwrite a newer one.
 */
import { MetricsStore, loadMetrics } from '../metrics/index.ts';
import { registerMetricsViews } from '../views/metrics.ts';
import type { ConnectionStatus } from '../discovery/index.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const metricsFeature: CockpitFeature = {
  id: 'metrics',
  activate(host: FeatureHost): void {
    const store = new MetricsStore();
    let generation = 0;

    const reload = async (): Promise<void> => {
      const client = host.getClient();
      if (!client) {
        store.clear();
        return;
      }
      const gen = ++generation;
      store.setLoading();
      const result = await loadMetrics(client, { windowId: store.state.windowId, nowMs: Date.now() });
      if (gen !== generation) return; // a newer reload (or a disconnect) superseded this one
      if (result.ok) {
        store.setResult(result.model, { partial: result.partial, fetchedAtMs: result.fetchedAtMs });
      } else {
        store.setError(result.detail);
      }
    };

    registerMetricsViews(host.context, store, reload);

    let connectedKey: string | null = null;
    const applyStatus = (status: ConnectionStatus): void => {
      const ep = status.endpoint;
      if (status.state === 'connected' && ep) {
        const key = `${ep.baseUrl}::${ep.token ?? ''}`;
        if (status.restarted || key !== connectedKey) {
          connectedKey = key;
          void reload();
        }
      } else if (status.state === 'unavailable' || status.state === 'idle') {
        if (connectedKey !== null) {
          connectedKey = null;
          generation += 1; // cancel any in-flight reload's result
          store.clear();
        }
      }
    };

    host.context.subscriptions.push(host.onStatusChange(applyStatus), {
      dispose: () => store.dispose(),
    });
  },
};

export default metricsFeature;
