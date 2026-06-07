/**
 * Saved Views feature: named, persisted snapshots of the bead filter + the panes
 * the operator lives in (cockpit-0vi).
 *
 * Connection-independent — saved views are client-side state in `globalState` and
 * are applied by driving the Beads explorer's filter and focusing panes — so it
 * needs no `onStatusChange` wiring, only the host's `context`. All the behaviour
 * lives in the tested `../savedViews` core and the `../views/savedViews.ts` glue.
 */
import { registerSavedViews } from '../views/savedViews.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const savedViewsFeature: CockpitFeature = {
  id: 'savedViews',
  activate(host: FeatureHost): void {
    registerSavedViews(host.context);
  },
};

export default savedViewsFeature;
