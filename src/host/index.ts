// Public surface of the cockpit host: the feature contract and the connection
// core that implements it. Features import the types from here; `extension.ts`
// imports `createCockpitHost`.
export {
  CONFIG_SECTION,
  type ClientEndpoint,
  type CockpitFeature,
  type FeatureHost,
  type StatusListener,
} from './types.ts';
export { createCockpitHost, type CockpitHostHandle } from './host.ts';
