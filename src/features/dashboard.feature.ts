/**
 * Dashboard feature: project (embed) the configured gascity dashboard into a
 * webview tab. The panel is dashboard-agnostic — driven by the `dashboard.url`
 * setting — and shows a configure placeholder until a URL is set.
 *
 * Keeps an open panel's tokenized API access in sync as the endpoint/token
 * changes (reconnect, supervisor restart, city switch), and re-renders the shell
 * when the `dashboard.url` setting changes.
 */
import * as vscode from 'vscode';
import { DashboardPanel, type DashboardPanelDeps } from '../dashboard/panel.ts';
import { CONFIG_SECTION, type CockpitFeature, type FeatureHost } from '../host/index.ts';

const dashboardFeature: CockpitFeature = {
  id: 'dashboard',
  activate(host: FeatureHost): void {
    const dashboardDeps: DashboardPanelDeps = {
      readDashboardUrl: () =>
        vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('dashboard.url', ''),
      readEndpoint: () => host.getEndpoint(),
      log: host.log,
    };

    host.context.subscriptions.push(
      vscode.commands.registerCommand(`${CONFIG_SECTION}.openDashboard`, () => {
        host.log('info', 'opening projected dashboard tab');
        DashboardPanel.show(dashboardDeps);
      }),
      // Keep an open projected dashboard's tokenized API access in sync as the
      // endpoint/token changes.
      host.onStatusChange(() => DashboardPanel.current?.refreshApi()),
      // The dashboard URL only needs the projected tab re-rendered.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG_SECTION}.dashboard.url`)) {
          DashboardPanel.current?.render();
        }
      }),
    );
  },
};

export default dashboardFeature;
