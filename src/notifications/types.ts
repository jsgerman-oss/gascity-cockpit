// Domain model for native VS Code notifications (cockpit-21l.7).
//
// The cockpit runs in a background pane, so the things that genuinely need a
// human — an agent escalating a blocker, a tool-approval blocking a session, a
// new piece of mail — must surface as native editor toasts rather than waiting
// unseen. This module is a Seam-1 layer (PRD Testing Decisions): a
// provider-agnostic core that turns supervisor signals (the SSE event feed and
// the aggregated pending-interactions endpoint) into {@link CockpitNotification}
// values. Nothing here imports `vscode`; the editor glue
// (`src/features/notifications.feature.ts`) renders these as toasts.

/** Which kind of signal produced a notification — each is independently toggleable. */
export type NotificationCategory = 'escalation' | 'approval' | 'mail';

/** How prominently to surface a notification. Blocking/attention signals warn. */
export type NotificationSeverity = 'info' | 'warning';

/**
 * A single thing worth surfacing as a native toast. Structured (rather than a
 * pre-rendered string) so the glue can attach the right actions: a tool-approval
 * carries the `city`/`sessionId`/`requestId` needed to allow or deny inline.
 */
export interface CockpitNotification {
  /**
   * Stable dedupe key, unique to the underlying signal. Event-backed
   * notifications key off the monotonic SSE `seq` (`mail:<seq>`, `esc:<seq>`);
   * approvals key off the interaction (`appr:<city>/<session>/<request>`). The
   * engine shows each id at most once.
   */
  readonly id: string;
  readonly category: NotificationCategory;
  readonly severity: NotificationSeverity;
  /** The headline shown in the toast. */
  readonly title: string;
  /** Optional secondary line (actor, message, subject). */
  readonly detail?: string;
  /** City the signal is tagged to, when known. */
  readonly city?: string;
  /** Session awaiting a decision — present for approvals. */
  readonly sessionId?: string;
  /** Pending-interaction request id to echo on respond — present for approvals. */
  readonly requestId?: string;
  /** Pending-interaction kind (e.g. `tool-approval`) — present for approvals. */
  readonly kind?: string;
}

/**
 * Per-category enablement. `enabled` is the master switch; the per-category
 * flags let an operator keep, say, escalations while muting chatty mail. Mirrors
 * the `gascityCockpit.notifications.*` settings.
 */
export interface NotificationPrefs {
  /** Master switch — when false, nothing is surfaced regardless of category. */
  readonly enabled: boolean;
  readonly escalations: boolean;
  readonly approvals: boolean;
  readonly mail: boolean;
}

/** Sensible defaults: everything on (matches the contributed setting defaults). */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  escalations: true,
  approvals: true,
  mail: true,
};
