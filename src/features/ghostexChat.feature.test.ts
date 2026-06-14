/**
 * Coverage for the Ghostex chat feature seam (bead zmux-6cc5cefc).
 *
 * The feature is a one-liner — it registers the chat command and wires it to the
 * host. We drive that seam against the fake host: registration + disposal. The
 * command's happy path (discover gxserver, pick a session, open the webview)
 * reaches gxserver and lives in the `vscode`-bound view glue (excluded from
 * coverage), so it is not exercised here — same split as the explorer and
 * agents-bridge features.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import ghostexChatFeature from './ghostexChat.feature.ts';
import { createTestbed } from '../test/fake-host.ts';

const CHAT = 'gascityCockpit.ghostex.session.chat';

afterEach(() => vi.restoreAllMocks());

describe('ghostex chat feature', () => {
  it('registers the chat command and removes it on dispose', () => {
    const tb = createTestbed();
    tb.activate(ghostexChatFeature);

    expect(tb.hasCommand(CHAT)).toBe(true);
    expect(tb.subscriptions()).toHaveLength(1);

    tb.disposeAll();
    expect(tb.hasCommand(CHAT)).toBe(false);
  });
});
