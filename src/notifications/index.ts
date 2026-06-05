// Public surface of the notifications feature core (cockpit-21l.7).
//
// The editor glue (`src/features/notifications.feature.ts`) imports from here;
// nothing in this barrel imports `vscode`, so the whole core stays in the Seam-1
// test layer.
export type {
  CockpitNotification,
  NotificationCategory,
  NotificationPrefs,
  NotificationSeverity,
} from './types.ts';
export { DEFAULT_NOTIFICATION_PREFS } from './types.ts';

export { classifyEvent, escalationTypes, isEscalationType } from './classify.ts';

export {
  approvalKey,
  fetchPendingApprovals,
  type PendingApproval,
} from './pending.ts';

export {
  DEFAULT_NOTIFICATION_ENGINE_OPTIONS,
  NotificationEngine,
  type NotificationEngineOptions,
} from './engine.ts';

export {
  approvalActions,
  approvalNotification,
  notificationMessage,
  type ApprovalAction,
} from './format.ts';
