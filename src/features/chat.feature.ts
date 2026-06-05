/**
 * Chat feature: open an interactive chat panel against a session. Accepts an
 * optional preset ({cityName, sessionId}) so other Cockpit surfaces can
 * deep-link in; otherwise it prompts for the city and session (Mayor first).
 */
import * as vscode from 'vscode';
import { openChat } from '../chat/index.ts';
import { CONFIG_SECTION, type CockpitFeature, type FeatureHost } from '../host/index.ts';

const chatFeature: CockpitFeature = {
  id: 'chat',
  activate(host: FeatureHost): void {
    host.context.subscriptions.push(
      vscode.commands.registerCommand(
        `${CONFIG_SECTION}.openChat`,
        (preset?: { cityName?: string; sessionId?: string }) =>
          openChat({ endpoint: host.getEndpoint(), log: host.log, ...(preset ? { preset } : {}) }),
      ),
    );
  },
};

export default chatFeature;
