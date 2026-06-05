/**
 * Worktree code lens feature (cockpit-21l.8): annotate files with the in-flight
 * beads/polecats editing them right now. It polls the shared beads repository and
 * runs read-only git, so it needs the repository and the logger; it refreshes its
 * index whenever the supervisor connection (re)connects or restarts, so the lens
 * reflects the fleet's current worktrees rather than a stale snapshot.
 */
import { registerWorktreeLens } from '../views/worktreeLens.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const worktreeLensFeature: CockpitFeature = {
  id: 'worktreeLens',
  activate(host: FeatureHost): void {
    const lens = registerWorktreeLens(host.context, {
      repository: host.repository,
      log: host.log,
    });
    host.context.subscriptions.push(
      host.onStatusChange((status, prevState) => {
        const justConnected = status.state === 'connected' && prevState !== 'connected';
        if (justConnected || status.restarted) lens.refresh();
      }),
    );
  },
};

export default worktreeLensFeature;
