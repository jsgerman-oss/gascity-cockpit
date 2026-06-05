// The notification engine: the stateful policy between raw supervisor signals
// and the toasts the glue shows.
//
// Two responsibilities, both `vscode`-free and unit-tested:
//   - dedupe: the SSE feed can redeliver and each connection is independent, so
//     every notification is shown at most once (keyed by its stable id);
//   - diff: approvals come as full snapshots, so the engine reports only the
//     newly-appeared ones and forgets the resolved ones.
// Category preferences gate everything, so muting a category is honoured here
// rather than left to the glue.
import type { FleetEvent } from '../status/index.ts';
import { classifyEvent } from './classify.ts';
import { approvalNotification } from './format.ts';
import { approvalKey, type PendingApproval } from './pending.ts';
import type { CockpitNotification, NotificationCategory, NotificationPrefs } from './types.ts';

export interface NotificationEngineOptions {
  /** Max remembered notification ids before the oldest are evicted. */
  readonly seenCap: number;
}

export const DEFAULT_NOTIFICATION_ENGINE_OPTIONS: NotificationEngineOptions = {
  seenCap: 500,
};

export class NotificationEngine {
  private prefs: NotificationPrefs;
  private readonly seenCap: number;
  /** Shown event-notification ids, insertion-ordered for oldest-first eviction. */
  private readonly seen = new Set<string>();
  /** Keys of the approvals observed as pending on the last sweep. */
  private activeApprovals = new Set<string>();

  constructor(prefs: NotificationPrefs, options: NotificationEngineOptions = DEFAULT_NOTIFICATION_ENGINE_OPTIONS) {
    this.prefs = prefs;
    this.seenCap = options.seenCap;
  }

  /** Swap the preference set (e.g. after the operator edits settings). */
  setPrefs(prefs: NotificationPrefs): void {
    this.prefs = prefs;
  }

  /**
   * Classify a fleet event and return a notification the first time it is seen
   * and its category is enabled; `null` otherwise (not notable, muted, or a
   * duplicate).
   */
  ingestEvent(event: FleetEvent): CockpitNotification | null {
    if (!this.prefs.enabled) return null;
    const notification = classifyEvent(event);
    if (!notification) return null;
    if (!this.categoryEnabled(notification.category)) return null;
    if (this.seen.has(notification.id)) return null;
    this.remember(notification.id);
    return notification;
  }

  /**
   * Diff a full pending-approvals snapshot against the previous one and return
   * the newly-appeared approvals as notifications. The active set is always
   * updated to the snapshot — so resolved approvals are forgotten and a genuinely
   * new interaction (a fresh `request_id`) re-notifies — even when the category
   * is muted, keeping the tracker accurate without flooding on re-enable.
   */
  ingestApprovals(current: readonly PendingApproval[]): CockpitNotification[] {
    const fresh = current.filter((a) => !this.activeApprovals.has(approvalKey(a)));
    this.activeApprovals = new Set(current.map(approvalKey));
    if (!this.prefs.enabled || !this.prefs.approvals) return [];
    return fresh.map(approvalNotification);
  }

  /**
   * Forget all history. Call on a supervisor restart: the SSE `seq` counter
   * resets (so old ids could collide) and the pending set is freshly meaningful.
   */
  reset(): void {
    this.seen.clear();
    this.activeApprovals.clear();
  }

  private categoryEnabled(category: NotificationCategory): boolean {
    if (category === 'escalation') return this.prefs.escalations;
    if (category === 'approval') return this.prefs.approvals;
    return this.prefs.mail;
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > this.seenCap) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
