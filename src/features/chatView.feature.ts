/**
 * Docked Mayor chat feature: a WebviewView pinned in the GasCity Cockpit
 * container, present by default (cockpit-dc8.1) — the "view by default" the
 * operator asked for, alongside the pop-out ChatPanel the `chat` feature opens.
 *
 * The provider (`../chat/chat-view.ts`) is thin glue over the shared, vscode-free
 * conversation core (ConversationStore / protocol / HTML builder); this feature
 * only registers it — with `retainContextWhenHidden` so the conversation survives
 * the view being hidden — plus its two title-bar actions: pop out to the full
 * editor panel, and switch which city/session the view is bound to.
 */
import * as vscode from "vscode";
import { ChatViewProvider } from "../chat/index.ts";
import { CONFIG_SECTION, type CockpitFeature, type FeatureHost } from "../host/index.ts";

const chatViewFeature: CockpitFeature = {
  id: "chatView",
  activate(host: FeatureHost): void {
    const provider = new ChatViewProvider(host);
    host.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand(`${CONFIG_SECTION}.chatView.popOut`, () => provider.popOut()),
      vscode.commands.registerCommand(`${CONFIG_SECTION}.chatView.switch`, () =>
        provider.switchTarget(),
      ),
      provider,
    );
  },
};

export default chatViewFeature;
