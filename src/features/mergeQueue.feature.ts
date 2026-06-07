/**
 * Merge-queue review feature: surface the beads the refinery is merging — with
 * their branch/PR and an in-editor diff — so an operator can review and approve
 * without leaving the editor (cockpit-21l.2).
 *
 * Reloads on meaningful connection transitions — first connect, a supervisor
 * restart, or the API dropping out — keying off the previous state the host
 * passes in, so routine health polls while connected don't reload the tree.
 */
import { registerMergeQueue } from "../views/mergeQueue.ts";
import { connectivityOf } from "../ui/index.ts";
import type { CockpitFeature, FeatureHost } from "../host/index.ts";

const mergeQueueFeature: CockpitFeature = {
  id: "mergeQueue",
  activate(host: FeatureHost): void {
    const queue = registerMergeQueue(host.context, { repository: host.repository });

    host.context.subscriptions.push(
      host.onStatusChange((status, prevState) => {
        // Surface the link state on every transition so a dropped supervisor
        // shows the shared reconnecting row, then reload only on the meaningful
        // transitions (first connect, restart, drop).
        queue.setConnectivity(connectivityOf(status.state));
        const connected = status.state === "connected" && prevState !== "connected";
        const dropped = status.state === "unavailable" && prevState !== "unavailable";
        if (connected || dropped || status.restarted) queue.refresh();
      }),
    );
  },
};

export default mergeQueueFeature;
