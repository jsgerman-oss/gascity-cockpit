# Native Notifications

> Status: **BUILT** (`src/notifications/`, `src/features/notifications.feature.ts`).
> Implements cockpit-21l.7. Builds on the feature registry (cockpit-1ll.15,
> `src/features/`), the live event stream (cockpit-1ll.6, `src/status/`), and the
> tool-approval domain layer (`src/api/approvals.ts`).

Native VS Code toasts for the three things that otherwise wait unseen while the
cockpit sits in a background pane: **escalations**, **tool-approvals**, and
**new mail**.

## Why this exists

Expansion epic cockpit-21l. The PRD's pain (story 23–26): *"when an agent pauses
for a tool-approval or asks me a question I only see it if I am attached to the
right tmux pane."* The same is true of an agent escalating a blocker or a piece
of mail landing. This feature lifts those signals out of the panes and into the
editor's own notification surface, where they interrupt at the right moment —
and, for tool-approvals, can be answered inline.

## What it watches

Two supervisor surfaces, because the signals live in two places:

| Category | Source | Signal |
|----------|--------|--------|
| **Mail** | SSE `/v0/events/stream` | a `mail.sent` event |
| **Escalation** | SSE `/v0/events/stream` | a curated set of "needs-a-human" events (see below) |
| **Approval** | `GET /v0/city/{city}/pending` | a newly-appeared pending interaction |

Approvals are **not** on the event feed — they are exposed per city by the
pending-interactions endpoint. So they are polled: immediately on connect, after
any `session.*` event (debounced — a session entering "waiting" is what creates
one), and on a periodic backstop (`approvalPollSeconds`). The sweep aggregates
every running city and is resilient — a city that fails to answer is skipped, so
one wedged rig never hides a blocked agent elsewhere.

### What counts as an escalation

A worker that needs attention, not routine lifecycle. The set is:
`session.crashed`, `session.stranded`, `session.quarantined`,
`session.cold_start_timeout`, `session.work_query_failed`,
`session.reset_stalled`, `session.drain_acked_with_assigned_work`,
`session.undrained`, `order.failed`, `request.failed`. Routine churn
(`woke` / `draining` / `idle_killed` / `max_age_killed` / `updated`) is
deliberately excluded.

## What it does

- **Mail** → an info toast (`New mail — from <actor>: <subject>`).
- **Escalation** → a warning toast (`Session crashed — <actor> · <detail>`).
- **Tool-approval** → a warning toast with inline **Allow** / **Deny**, which
  `POST .../respond` with the interaction's `request_id` echoed so a stale prompt
  is never answered by mistake.
- **Prompt-for-input** → a warning toast (notify-only: the submit token is
  provider-specific and not carried by the city-level aggregation, so we never
  guess an answer).
- Info/escalation toasts and notify-only approvals offer **Show in Event Feed**,
  which focuses the live events pane.

Each toast fires **once** — the engine dedupes events by their monotonic SSE
`seq` and diffs approval snapshots so only newly-appeared interactions notify
(resolved ones are forgotten; a genuinely new `request_id` re-notifies). On a
supervisor restart the engine resets, since the `seq` counter restarts.

### Command

- **GasCity Cockpit: Show Pending Approvals** (`gascityCockpit.notifications.showPending`)
  — an on-demand picker of every pending approval across the fleet (toasts are
  transient; this is the durable way to find what is waiting). Acting on a pick
  reuses the same allow/deny path.

## Settings

| Setting | Default | Effect |
|---------|---------|--------|
| `gascityCockpit.notifications.enabled` | `true` | Master switch. |
| `gascityCockpit.notifications.escalations` | `true` | Escalation toasts. |
| `gascityCockpit.notifications.approvals` | `true` | Approval toasts + polling. |
| `gascityCockpit.notifications.mail` | `true` | Mail toasts. |
| `gascityCockpit.notifications.approvalPollSeconds` | `15` (min 5) | Backstop poll interval. |

## How it is built

Following the [feature guardrails](contributing-features.md): a `vscode`-free,
unit-tested core plus thin editor glue.

```
src/notifications/         the Seam-1 core — NO `vscode` imports
  types.ts                 CockpitNotification, NotificationCategory, prefs
  classify.ts              pure FleetEvent → notification (mail + escalations)
  pending.ts               fetchPendingApprovals() — fleet-wide pending union
  engine.ts                dedupe + preference gating + approval diff + reset
  format.ts                toast message + allow/deny action mapping
  index.ts                 public barrel
src/features/
  notifications.feature.ts thin glue: owns the SSE stream, polls pending,
                           shows toasts, wires respond + the picker
  notifications.contributes.json  the command + settings
```

Like the live-status feature, the glue owns **its own** `SupervisorEventStream`
rather than reaching into another feature's state — feature independence is the
parallel-merge guardrail, and a second SSE subscription is cheap. The toast
wording, the dedupe/diff policy, and the allow/deny mapping are all in the core,
so the only untested surface is the editor plumbing.
