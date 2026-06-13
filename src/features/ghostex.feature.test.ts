/**
 * Wiring test for the Ghostex feature: activating it must register the Sessions
 * view and the full `gascityCockpit.ghostex.*` command surface (the foundation's
 * status commands plus this bead's session-driving commands), and dispose them
 * cleanly. We assert *registration* only — invoking a drive command would spawn
 * the `gx` CLI, so the behaviour of each command is covered in `ghostex/drive.test.ts`
 * against a fake client instead.
 */
import { describe, expect, it } from 'vitest';
import ghostexFeature from './ghostex.feature.ts';
import { createTestbed } from '../test/fake-host.ts';

const DRIVE_COMMANDS = [
  'gascityCockpit.ghostex.createSession',
  'gascityCockpit.ghostex.createAgentSession',
  'gascityCockpit.ghostex.renameSession',
  'gascityCockpit.ghostex.focusSession',
  'gascityCockpit.ghostex.sleepSession',
  'gascityCockpit.ghostex.wakeSession',
  'gascityCockpit.ghostex.killSession',
  'gascityCockpit.ghostex.sendText',
  'gascityCockpit.ghostex.sendMessage',
  'gascityCockpit.ghostex.readText',
];

describe('ghostex feature (end-to-end through the harness)', () => {
  it('registers the Sessions view and every drive command', () => {
    const tb = createTestbed();
    tb.activate(ghostexFeature);

    expect(tb.getView('gascityCockpitGhostex.sessions')).toBeDefined();
    for (const id of ['gascityCockpit.ghostex.refresh', ...DRIVE_COMMANDS]) {
      expect(tb.hasCommand(id), `command ${id} should be registered`).toBe(true);
    }
  });

  it('disposes its commands when the host tears down', () => {
    const tb = createTestbed();
    tb.activate(ghostexFeature);
    expect(tb.hasCommand('gascityCockpit.ghostex.createAgentSession')).toBe(true);

    tb.disposeAll();
    expect(tb.hasCommand('gascityCockpit.ghostex.createAgentSession')).toBe(false);
  });
});
