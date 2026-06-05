import { describe, expect, it } from 'vitest';
import { Emitter } from '../discovery/index';
import { LiveTelemetry } from './live';
import { TelemetryStore } from './store';
import type { TelemetryStream } from './events';
import type { TelemetryStreamStatus, WorkerOperation } from './types';

const op = (seq: number): WorkerOperation => ({
  seq,
  ts: 't',
  city: 'c',
  agent: 'A',
  bead: 'b1',
  model: 'm1',
  provider: 'claude',
  operation: 'op',
  result: 'success',
  ok: true,
  durationMs: 1,
  opId: `o${seq}`,
});

/** A stand-in for TelemetryStream that records lifecycle calls. */
class FakeStream {
  readonly events = new Emitter<WorkerOperation>();
  readonly statuses = new Emitter<TelemetryStreamStatus>();
  readonly onEvent = this.events.event;
  readonly onStatus = this.statuses.event;
  started = 0;
  disposed = 0;
  start(): void {
    this.started += 1;
  }
  dispose(): void {
    this.disposed += 1;
    this.events.dispose();
    this.statuses.dispose();
  }
}

describe('LiveTelemetry', () => {
  it('starts a stream and pipes its events and status into the store', () => {
    const store = new TelemetryStore();
    const streams: FakeStream[] = [];
    const live = new LiveTelemetry({
      store,
      createStream: () => {
        const s = new FakeStream();
        streams.push(s);
        return s as unknown as TelemetryStream;
      },
    });

    live.connect({ baseUrl: 'http://h' });
    expect(streams[0]!.started).toBe(1);

    streams[0]!.events.fire(op(1));
    expect(store.state.totals.operations).toBe(1);
    streams[0]!.statuses.fire({ state: 'open', detail: 'streaming', attempt: 0 });
    expect(store.state.stream?.state).toBe('open');

    live.dispose();
    expect(streams[0]!.disposed).toBe(1);
  });

  it('tears down the prior stream when reconnecting', () => {
    const store = new TelemetryStore();
    const streams: FakeStream[] = [];
    const live = new LiveTelemetry({
      store,
      createStream: () => {
        const s = new FakeStream();
        streams.push(s);
        return s as unknown as TelemetryStream;
      },
    });

    live.connect({ baseUrl: 'http://h1' });
    live.connect({ baseUrl: 'http://h2' });
    expect(streams).toHaveLength(2);
    expect(streams[0]!.disposed).toBe(1);
    expect(streams[1]!.started).toBe(1);

    // After the old stream is disposed, its events no longer reach the store.
    store.clear();
    streams[0]!.events.fire(op(9));
    expect(store.state.totals.operations).toBe(0);

    live.dispose();
  });
});
