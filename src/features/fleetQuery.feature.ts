/**
 * Fleet command-palette feature: a natural-language query bar that resolves
 * plain-language requests ("blocked beads in cockpit") into structured /v0
 * queries across every city (cockpit-21l.1).
 *
 * Stateless with respect to the connection — the command loads a fresh
 * multi-city snapshot through the shared beads repository each time it is
 * invoked — so it needs no `onStatusChange` wiring, only the host's repository.
 */
import { registerFleetPalette } from '../views/fleetPalette.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const fleetQueryFeature: CockpitFeature = {
  id: 'fleetQuery',
  activate(host: FeatureHost): void {
    registerFleetPalette(host.context, { repository: host.repository });
  },
};

export default fleetQueryFeature;
