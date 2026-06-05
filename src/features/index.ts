/**
 * The cockpit feature registry.
 *
 * `extension.ts` builds a {@link FeatureHost} and calls {@link activateFeatures};
 * each feature wires itself onto the host. Adding a feature is a new module here
 * plus one import + one array entry below (and a `<id>.contributes.json` for any
 * package.json contributions) — never an edit to `extension.ts`. That is what
 * lets features merge in parallel (cockpit-1ll.15): the only shared touch-point
 * is this append-only list, not the activation body the refinery cannot
 * conflict-resolve.
 *
 * Activation order follows array order. It does not affect UX (view order is set
 * by package.json, menus by `group@order`); it only orders status-change
 * reactions, which are independent.
 */
import type { CockpitFeature, FeatureHost } from '../host/index.ts';
import statusFeature from './status.feature.ts';
import beadsFeature from './beads.feature.ts';
import beadFromSelectionFeature from './beadFromSelection.feature.ts';
import codeNavFeature from './codeNav.feature.ts';
import formulaFlowsFeature from './formulaFlows.feature.ts';
import chatFeature from './chat.feature.ts';
import dashboardFeature from './dashboard.feature.ts';
import extmsgFeature from './extmsg.feature.ts';
import fleetQueryFeature from './fleetQuery.feature.ts';
import mergeQueueFeature from './mergeQueue.feature.ts';
import timeTravelFeature from './timeTravel.feature.ts';

/** Every cockpit feature, in activation order. Append new features here. */
export const FEATURES: readonly CockpitFeature[] = [
  statusFeature,
  beadsFeature,
  beadFromSelectionFeature,
  codeNavFeature,
  formulaFlowsFeature,
  chatFeature,
  dashboardFeature,
  extmsgFeature,
  fleetQueryFeature,
  mergeQueueFeature,
  timeTravelFeature,
];

/** Activate every registered feature against the shared host. */
export function activateFeatures(host: FeatureHost): void {
  for (const feature of FEATURES) feature.activate(host);
}
