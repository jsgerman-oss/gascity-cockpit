/**
 * Event time-travel feature: records the supervisor event feed into a replayable
 * timeline and opens a scrubber webview to step and replay it (cockpit-21l.6).
 *
 * It runs its own durable {@link SupervisorEventStream} — separate from the live
 * status feature's — wired to the connection through `host.onStatusChange`, the
 * same way `status.feature.ts` drives its feed. Features are isolated (the host
 * deliberately does not share the event stream), so the modest cost of a second
 * localhost SSE connection buys a purpose-built audit recorder: chronological and
 * larger-capped than the live feed's newest-first ring. `liveKey` dedupes the
 * connected endpoint so routine health polls don't churn the stream; a detected
 * supervisor restart clears the recording (the seq counter resets across epochs).
 */
import { bearerAuthHeader } from '../api/index.ts';
import { SupervisorEventStream } from '../status/index.ts';
import { EventTimeline } from '../timetravel/index.ts';
import { registerTimeTravel } from '../views/timeTravel.ts';
import type { ConnectionStatus, Disposable } from '../discovery/index.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const timeTravelFeature: CockpitFeature = {
  id: 'timeTravel',
  activate(host: FeatureHost): void {
    const timeline = new EventTimeline();
    registerTimeTravel(host.context, { timeline });

    let stream: SupervisorEventStream | null = null;
    let streamSub: Disposable | null = null;
    let liveKey: string | null = null;

    const teardownStream = (): void => {
      streamSub?.dispose();
      streamSub = null;
      stream?.dispose();
      stream = null;
    };

    const startStream = (baseUrl: string, token: string | null): void => {
      teardownStream();
      const s = new SupervisorEventStream(baseUrl, {
        headers: bearerAuthHeader(token),
        log: host.log,
      });
      stream = s;
      streamSub = s.onEvent((event) => timeline.record(event));
      s.start();
    };

    const applyStatus = (status: ConnectionStatus): void => {
      const ep = status.endpoint;
      if (status.state === 'connected' && ep) {
        const key = `${ep.baseUrl}::${ep.token ?? ''}`;
        if (status.restarted || key !== liveKey) {
          if (status.restarted) timeline.clear();
          liveKey = key;
          startStream(ep.baseUrl, ep.token);
        }
      } else if (status.state === 'unavailable' || status.state === 'idle') {
        if (liveKey !== null) {
          liveKey = null;
          teardownStream();
        }
      }
    };

    host.context.subscriptions.push(
      host.onStatusChange(applyStatus),
      {
        dispose: () => {
          teardownStream();
          timeline.dispose();
        },
      },
    );
  },
};

export default timeTravelFeature;
