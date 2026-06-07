// Replay-to-regression: every committed scenario must replay through the domain
// store and reproduce its frozen derived state exactly (cockpit-6x0). A failure
// here means the recorder (de-dup/cap) or the feed projection changed the state a
// real recorded run derives — i.e. event time-travel would replay differently.
// Regenerate a fixture deliberately only when that change is intended.
import { describe, expect, it } from 'vitest';
import { runScenario } from './scenario.ts';
import { SAVED_SCENARIOS } from './scenarios/index.ts';

describe('saved replay scenarios', () => {
  it('ships at least one committed scenario', () => {
    expect(SAVED_SCENARIOS.length).toBeGreaterThan(0);
  });

  it('has a unique name per scenario', () => {
    const names = SAVED_SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(SAVED_SCENARIOS.map((s) => [s.name, s] as const))(
    'replays "%s" with no drift from its frozen derived state',
    (_name, scenario) => {
      const result = runScenario(scenario);
      // Surface the actual drift in the failure message rather than a bare false.
      expect(result.drift).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );

  it('covers the recorder behaviours the scenarios are meant to guard', () => {
    const byName = new Map(SAVED_SCENARIOS.map((s) => [s.name, s]));

    // De-dup: the reconnect fixture stores a duplicate seq that must not appear
    // in the derived rows.
    const reconnect = byName.get('reconnect-dedup');
    expect(reconnect).toBeDefined();
    if (reconnect) {
      expect(reconnect.events.length).toBeGreaterThan(reconnect.expected.rows.length);
    }

    // Cap eviction: the overflow fixture records more events than its cap, so the
    // derived window is exactly `cap` rows.
    const overflow = byName.get('ring-overflow');
    expect(overflow).toBeDefined();
    if (overflow) {
      expect(overflow.events.length).toBeGreaterThan(overflow.cap);
      expect(overflow.expected.rows.length).toBe(overflow.cap);
    }
  });
});
