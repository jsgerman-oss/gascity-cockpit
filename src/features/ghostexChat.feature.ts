/**
 * Ghostex chat feature: register the command that chats with a Ghostex-hosted
 * agent session — submit routes to gxserver `sendSessionMessage`, output streams
 * back via `readSessionText` + the `/api/events` feed, rendered through the shared
 * chat webview.
 *
 * All testable logic lives in the `vscode`-free core (`../ghostex/chatBridge.ts`);
 * the editor glue — discovery, the RPC client, the events stream, the webview — is
 * in `../views/ghostexChat.ts`. This feature is just the registration seam, kept
 * appendable so it merges in parallel with the other Ghostex features.
 */
import { registerGhostexChat } from '../views/ghostexChat.ts';
import type { CockpitFeature, FeatureHost } from '../host/index.ts';

const ghostexChatFeature: CockpitFeature = {
  id: 'ghostexChat',
  activate(host: FeatureHost): void {
    registerGhostexChat(host);
  },
};

export default ghostexChatFeature;
