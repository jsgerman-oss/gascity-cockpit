/**
 * Native notifications feature (cockpit-21l.7): surface escalations,
 * tool-approvals, and new mail as native VS Code toasts so nothing waits unseen
 * while the cockpit sits in a background pane.
 *
 * Like the live-status feature, this owns its own supervisor event stream rather
 * than reaching into another feature's state — the parallel-merge guardrail is
 * feature independence, and a second SSE subscription is cheap. Mail and
 * escalations are read off that stream; tool-approvals are not on the feed, so
 * they are polled from `/v0/city/{city}/pending` — immediately on connect, after
 * any `session.*` event (debounced), and on a periodic backstop. All policy
 * (what's notable, dedupe, the new-approval diff) lives in the `vscode`-free
 * `../notifications` core; this file is the thin editor glue (toasts, the inline
 * allow/deny respond, the on-demand picker) and is intentionally not unit-tested.
 */
import * as vscode from 'vscode';
import { bearerAuthHeader, respond } from '../api/index.ts';
import { SupervisorEventStream, type FleetEvent } from '../status/index.ts';
import type { ConnectionStatus } from '../discovery/index.ts';
import {
  approvalActions,
  approvalNotification,
  fetchPendingApprovals,
  NotificationEngine,
  notificationMessage,
  type CockpitNotification,
  type NotificationPrefs,
  type PendingApproval,
} from '../notifications/index.ts';
import { CONFIG_SECTION, type CockpitFeature, type FeatureHost } from '../host/index.ts';

const EVENTS_VIEW = 'gascityCockpit.events';
const SHOW_PENDING_CMD = `${CONFIG_SECTION}.notifications.showPending`;
const SHOW_IN_FEED = 'Show in Event Feed';
const SESSION_EVENT_PREFIX = 'session.';
/** Coalesce the burst of `session.*` events a single transition produces. */
const APPROVAL_POLL_DEBOUNCE_MS = 600;

const notificationsFeature: CockpitFeature = {
  id: 'notifications',
  activate(host: FeatureHost): void {
    let prefs = readPrefs();
    const engine = new NotificationEngine(prefs);

    let stream: SupervisorEventStream | null = null;
    let liveKey: string | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollAbort: AbortController | null = null;

    const teardown = (): void => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (pollAbort) {
        pollAbort.abort();
        pollAbort = null;
      }
      if (stream) {
        stream.dispose();
        stream = null;
      }
      liveKey = null;
    };

    const pollApprovals = async (): Promise<void> => {
      const client = host.getClient();
      if (!client) return;
      if (pollAbort) pollAbort.abort();
      const abort = new AbortController();
      pollAbort = abort;
      try {
        const pending = await fetchPendingApprovals(client, { signal: abort.signal });
        for (const notification of engine.ingestApprovals(pending)) void showToast(host, notification);
      } catch (err) {
        host.log('warn', 'pending-approvals poll failed', { error: errorMessage(err) });
      } finally {
        if (pollAbort === abort) pollAbort = null;
      }
    };

    const scheduleApprovalPoll = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void pollApprovals();
      }, APPROVAL_POLL_DEBOUNCE_MS);
    };

    const onEvent = (event: FleetEvent): void => {
      const notification = engine.ingestEvent(event);
      if (notification) void showToast(host, notification);
      // Any session transition may have created or cleared a pending approval.
      if (event.type.startsWith(SESSION_EVENT_PREFIX)) scheduleApprovalPoll();
    };

    const connect = (status: ConnectionStatus): void => {
      const endpoint = status.endpoint;
      if (!endpoint) return;
      const key = `${endpoint.baseUrl}::${endpoint.token ?? ''}`;
      if (!status.restarted && key === liveKey) return; // routine health poll
      if (status.restarted) engine.reset(); // seq resets; pending is freshly meaningful
      teardown();
      liveKey = key;

      const eventStream = new SupervisorEventStream(endpoint.baseUrl, {
        headers: bearerAuthHeader(endpoint.token),
        log: host.log,
      });
      stream = eventStream;
      // The listener lives and dies with the stream (disposed in teardown), so it
      // is not pushed onto context.subscriptions — that would accumulate across
      // reconnects.
      eventStream.onEvent(onEvent);
      eventStream.start();

      void pollApprovals();
      pollTimer = setInterval(() => void pollApprovals(), readPollMs());
    };

    const applyStatus = (status: ConnectionStatus): void => {
      if (!prefs.enabled) {
        teardown();
        return;
      }
      if (status.state === 'connected') {
        connect(status);
      } else if (status.state === 'unavailable' || status.state === 'idle') {
        teardown();
      }
    };

    host.context.subscriptions.push(
      host.onStatusChange(applyStatus),
      vscode.commands.registerCommand(SHOW_PENDING_CMD, () => showPendingApprovals(host)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(`${CONFIG_SECTION}.notifications`)) return;
        prefs = readPrefs();
        engine.setPrefs(prefs);
        // Re-evaluate from scratch so a toggled master switch or a changed poll
        // interval takes effect; engine state (dedupe/active set) persists, so no
        // re-flood. A settings edit is rare enough that an SSE reconnect is fine.
        teardown();
        applyStatus(host.getStatus());
      }),
      { dispose: teardown },
    );
    // No initial applyStatus() call: features subscribe before host.start(), so
    // onStatusChange delivers the first connect (mirrors the status feature).
  },
};

/** Show one notification as the appropriate native toast, wiring its actions. */
async function showToast(host: FeatureHost, n: CockpitNotification): Promise<void> {
  if (n.category === 'approval') {
    const actions = approvalActions(n);
    if (actions.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        notificationMessage(n),
        ...actions.map((a) => a.label),
      );
      const action = actions.find((a) => a.label === choice);
      if (action) await respondToApproval(host, n, action.action);
      return;
    }
    // Notify-only (prompt-for-input): point the operator at the session.
    if ((await vscode.window.showWarningMessage(notificationMessage(n), SHOW_IN_FEED)) === SHOW_IN_FEED) {
      void focusEventFeed();
    }
    return;
  }

  const message = notificationMessage(n);
  const choice =
    n.severity === 'warning'
      ? await vscode.window.showWarningMessage(message, SHOW_IN_FEED)
      : await vscode.window.showInformationMessage(message, SHOW_IN_FEED);
  if (choice === SHOW_IN_FEED) void focusEventFeed();
}

/** Send an allow/deny (or provider-specific) response for an approval toast. */
async function respondToApproval(host: FeatureHost, n: CockpitNotification, action: string): Promise<void> {
  const client = host.getClient();
  if (!client || !n.city || !n.sessionId) {
    void vscode.window.showWarningMessage('Not connected — could not respond to the approval.');
    return;
  }
  const result = await respond(client, n.city, n.sessionId, {
    action,
    ...(n.requestId ? { requestId: n.requestId } : {}),
  });
  if (result.ok) {
    host.log('info', 'approval response sent', { action, city: n.city, session: n.sessionId });
  } else {
    void vscode.window.showErrorMessage(`Could not ${action} the approval: ${result.error.title}`);
  }
}

/** Command: list current pending approvals and act on the chosen one. */
async function showPendingApprovals(host: FeatureHost): Promise<void> {
  const client = host.getClient();
  if (!client) {
    void vscode.window.showWarningMessage('Not connected to a supervisor API.');
    return;
  }
  const pending = await fetchPendingApprovals(client);
  if (pending.length === 0) {
    void vscode.window.showInformationMessage('No pending approvals across the fleet.');
    return;
  }
  type Item = vscode.QuickPickItem & { pending: PendingApproval };
  const pick = await vscode.window.showQuickPick<Item>(
    pending.map((p) => ({
      label: `$(bell) ${p.sessionId}`,
      description: `${p.kind} · ${p.city}`,
      pending: p,
    })),
    { title: 'Pending approvals', placeHolder: 'Select an agent waiting for a decision' },
  );
  if (pick) await showToast(host, approvalNotification(pick.pending));
}

function focusEventFeed(): Thenable<unknown> {
  return vscode.commands.executeCommand(`${EVENTS_VIEW}.focus`);
}

function readPrefs(): NotificationPrefs {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: cfg.get<boolean>('notifications.enabled', true),
    escalations: cfg.get<boolean>('notifications.escalations', true),
    approvals: cfg.get<boolean>('notifications.approvals', true),
    mail: cfg.get<boolean>('notifications.mail', true),
  };
}

function readPollMs(): number {
  const seconds = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>('notifications.approvalPollSeconds', 15);
  return Math.max(5, seconds) * 1000;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default notificationsFeature;
