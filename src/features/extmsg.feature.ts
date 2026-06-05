/**
 * extmsg participant feature (cockpit-1ll.12): registers VS Code as a
 * first-class, durable extmsg adapter.
 *
 * A loopback callback service gives the supervisor a reachable URL for outbound
 * delivery; the participant registers the Cockpit adapter in each running city
 * and re-registers on every (re)connect, since the supervisor's adapter registry
 * is in-memory and ephemeral (pack `docs/DESIGN.md` fork #2). `participantKey`
 * dedupes the connected endpoint like the live status does.
 */
import * as vscode from 'vscode';
import { CallbackServer, ExtMsgParticipant, type ParticipantEndpoint } from '../extmsg/index.ts';
import type { ConnectionStatus } from '../discovery/index.ts';
import { CONFIG_SECTION, type CockpitFeature, type FeatureHost } from '../host/index.ts';

const extmsgFeature: CockpitFeature = {
  id: 'extmsg',
  activate(host: FeatureHost): void {
    const callbackServer = new CallbackServer({ log: host.log });
    const participant = new ExtMsgParticipant({
      createClient: (ep) => host.createClient(ep),
      callbackServer,
      onDelivery: (d) =>
        host.log('info', 'extmsg delivery received on Cockpit callback', { receivedAt: d.receivedAt }),
      log: host.log,
    });

    let participantKey: string | null = null;
    const applyParticipant = (status: ConnectionStatus): void => {
      const ep = status.endpoint;
      if (status.state === 'connected' && ep) {
        const key = `${ep.baseUrl}::${ep.token ?? ''}`;
        if (status.restarted || key !== participantKey) {
          participantKey = key;
          const endpoint: ParticipantEndpoint = {
            baseUrl: ep.baseUrl,
            ...(ep.token ? { token: ep.token } : {}),
          };
          void participant
            .connect(endpoint)
            .catch((err) =>
              host.log('warn', 'extmsg participant connect failed', {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
        }
      } else if (status.state === 'unavailable' || status.state === 'idle') {
        if (participantKey !== null) {
          participantKey = null;
          void participant.disconnect().catch(() => {});
        }
      }
    };

    host.context.subscriptions.push(
      host.onStatusChange(applyParticipant),
      // Show the reachable callback URL, per-city registration state, and recent
      // delivery count. Offers to copy the URL.
      vscode.commands.registerCommand(`${CONFIG_SECTION}.extmsg.showStatus`, async () => {
        const url = participant.callbackUrl;
        const regs = participant.registrations;
        const summary = regs.length
          ? regs.map((r) => `${r.city}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`).join(', ')
          : 'not registered';
        host.showOutput();
        host.log(
          'info',
          `extmsg participant — callback ${url ?? '(not started)'}; registrations: ${summary}; deliveries: ${participant.recentDeliveries.length}`,
        );
        const actions = url ? ['Copy Callback URL', 'Show Log'] : ['Show Log'];
        const choice = await vscode.window.showInformationMessage(
          `extmsg participant: ${summary}`,
          ...actions,
        );
        if (choice === 'Copy Callback URL' && url) {
          await vscode.env.clipboard.writeText(url);
        } else if (choice === 'Show Log') {
          host.showOutput();
        }
      }),
      // Unregister the adapter and stop the callback service on deactivate.
      { dispose: () => void participant.dispose() },
    );
  },
};

export default extmsgFeature;
