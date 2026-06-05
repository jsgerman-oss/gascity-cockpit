/**
 * Code navigation feature: bead → worktree → diff (read-only). Stateless with
 * respect to the connection — it resolves worktree paths from bead metadata and
 * runs read-only git — so it only needs the shared beads repository.
 */
import { registerCodeNav } from '../views/codeNav.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const codeNavFeature: CockpitFeature = {
  id: 'codeNav',
  activate(host: FeatureHost): void {
    registerCodeNav(host.context, { repository: host.repository });
  },
};

export default codeNavFeature;
