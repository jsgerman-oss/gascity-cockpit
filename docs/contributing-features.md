# Contributing a feature — the parallel-merge guardrails

The Cockpit grows by adding **features**: the beads explorer, live status panes,
chat, the dashboard projection, code navigation, formula flows, the extmsg
participant. Many of these land at once, from different polecats. This document
is the contract that lets them **merge in parallel** instead of fighting over
two shared files — `src/extension.ts` and `package.json`.

The rule of thumb: **a feature is a self-contained module that wires itself onto
a shared host. Adding one never edits another feature's code, and never edits
the activation body or the `contributes` block by hand.**

## Why this exists

Before the feature registry (cockpit-1ll.15), every feature edited `activate()`
in `src/extension.ts` to construct itself and to react to connection changes,
and edited `package.json`'s `contributes` arrays to add its commands/menus/views.
Two features in flight at once produced **app-logic conflicts** in `activate()`
that the refinery cannot resolve, and noisy array conflicts in `package.json`.

The fix moves the per-feature wiring out of the shared files:

- `src/extension.ts` builds **one** [`FeatureHost`](../src/host/types.ts) and
  activates every registered feature against it. It does not change when a
  feature is added.
- Each feature lives in `src/features/<id>.feature.ts` and registers itself.
- Each feature owns its `package.json` contributions in
  `src/features/<id>.contributes.json`; `npm run sync:contributes` merges them.

## The architecture

```
src/
  host/                 the connection core + the feature contract
    types.ts            FeatureHost, CockpitFeature, CONFIG_SECTION
    host.ts             createCockpitHost() — discovery, client, status bar, logger
    index.ts            public barrel
  features/
    index.ts            the FEATURES registry + activateFeatures(host)
    <id>.feature.ts     one module per feature; `export default` a CockpitFeature
    <id>.contributes.json   that feature's package.json contributions
    _core.contributes.json  shared container + connection commands + api.* settings
    contributes.test.ts drift guard (manifests ⇄ package.json)
  extension.ts          thin: build host, activate features, start
```

`extension.ts` in full is essentially:

```ts
export function activate(context: vscode.ExtensionContext): void {
  const { host, start } = createCockpitHost(context);
  activateFeatures(host);
  start();
}
```

The [`FeatureHost`](../src/host/types.ts) is everything a feature needs from the
core:

| Member | Use |
| --- | --- |
| `context` | push your disposables onto `context.subscriptions` |
| `log` | the shared output-channel logger |
| `repository` | the shared, connection-backed `BeadsRepository` |
| `getClient()` | the live typed `/v0` client, or `null` when disconnected |
| `getEndpoint()` | the resolved endpoint, or `null` |
| `getStatus()` | the latest `ConnectionStatus` snapshot |
| `createClient(ep, timeoutMs?)` | build a typed client for an arbitrary endpoint |
| `onStatusChange(listener)` | react to connect / restart / drop (see below) |
| `reconnect()` / `showOutput()` | drive the connection / reveal the log |

## Adding a feature

### 1. Put the logic in a `vscode`-free domain core

The behavior worth testing — parsing, derivation, formatting, state — goes in a
module with **no `vscode` import** (`src/<feature>/…`, like `src/beads`,
`src/status`, `src/formulas`). That is what keeps it unit-testable in plain Node
under vitest (the PRD's Seam 1). The editor-bound layer stays thin.

### 2. Write the thin glue

A `register<Feature>(context, deps)` function (or a panel class) maps the core
onto VS Code surfaces — tree providers, webviews, content providers, commands.
Keep it free of connection bookkeeping; take what you need as `deps`. This layer
is intentionally **not** unit-tested.

### 3. Write the feature descriptor

`src/features/<id>.feature.ts` adapts the host to your glue and owns any
status-change reactions. `export default` a `CockpitFeature`:

```ts
import { registerWidget } from '../widget/view.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const widgetFeature: CockpitFeature = {
  id: 'widget',
  activate(host: FeatureHost): void {
    registerWidget(host.context, { repository: host.repository, log: host.log });
  },
};

export default widgetFeature;
```

**React to the connection via `host.onStatusChange`, not a central fan-out.**
The listener receives the new status and the previous state, so you can act on
transitions exactly like the core used to:

```ts
host.context.subscriptions.push(
  host.onStatusChange((status, prevState) => {
    const justConnected = status.state === 'connected' && prevState !== 'connected';
    if (justConnected || status.restarted) controller.refresh();
  }),
);
```

### 4. Register it (one line)

Add the import and the array entry in [`src/features/index.ts`](../src/features/index.ts):

```ts
import widgetFeature from './widget.feature.ts';

export const FEATURES: readonly CockpitFeature[] = [
  // …existing features…
  widgetFeature,
];
```

This is the **only** shared touch-point, and it is append-only — a trivial
textual merge, never an app-logic conflict. Activation order does not affect UX
(view order comes from `package.json`, menu order from `group@order`); it only
orders status-change reactions, which are independent.

### 5. Declare your `package.json` contributions

Create `src/features/<id>.contributes.json` with **only the slice your feature
adds** — its commands, menus, views, or configuration. Then regenerate:

```bash
npm run sync:contributes        # merge manifests → package.json contributes
npm run sync:contributes:check  # CI/pre-push guard: fail if package.json is stale
```

Never hand-edit the `contributes` block in `package.json` — it is generated.
Two features adding their own manifest never conflict; the merged `package.json`
is regenerated and any conflict there is resolved by re-running the sync. Menu
ordering is by `group@order`, so array position is irrelevant; the one place
array order matters — the activity-bar **view** order — is pinned by
`FEATURE_ORDER` in [`scripts/lib/contributes.mjs`](../scripts/lib/contributes.mjs)
and asserted by the test.

`src/features/contributes.test.ts` re-derives the merge independently and fails
under `npm run check` if `package.json` drifts from the manifests, if a command
is declared by two features, or if a menu references an undeclared command.

## The guardrails, in one list

- **Thin activation.** `src/extension.ts` and `src/host/` are the stable core.
  A feature never edits them — it registers through `FEATURES` and reacts through
  `host.onStatusChange`.
- **`vscode`-free domain cores.** Testable logic imports no `vscode`; it is
  proven in plain Node. The editor glue stays thin and untested.
- **Own your contributions.** Each feature carries its own `*.contributes.json`;
  `package.json` is generated, never hand-merged.
- **Rebase on latest `main` before the refinery handoff.** Pull the merged work
  of features that landed while you were building, rebase your branch on it, and
  re-run the gate. The registry and the manifests are designed so this rebase is
  clean; the refinery merges branches it can fast-forward and rejects ones that
  carry stale conflicts.
- **`npm run check` is the pre-push gate.** `typecheck + lint + test` must pass
  locally before you push — and `test` includes the contributes drift guard, so
  a stale `package.json` fails the gate rather than the refinery.

```bash
npm run check   # typecheck + lint + test — run before every push
```
