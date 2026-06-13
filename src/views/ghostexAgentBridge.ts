/**
 * Ghostex agents-bridge — the editor glue (PRD "Seam 1": thin, `vscode`-bound,
 * excluded from coverage). It wires the `vscode`-free bridge core
 * (`../ghostex/agentBridge.ts`) to the live world:
 *
 *   - `…ghostex.launchAgentForBead` — from a bead selected in the Beads explorer,
 *     connect to gxserver, launch the bead's agent INTO a Ghostex pane via
 *     `gx create-agent` (agentId/project/cwd derived from the bead's worktree),
 *     and persist the bead ↔ `S:P:G` linkage by updating the bead's metadata
 *     over /v0 — so the session can be revealed/attached later.
 *   - `…ghostex.revealAgentForBead` — read that linkage back off the bead and
 *     focus the linked Ghostex session.
 *
 * All the testable logic (derivation, project resolution, orchestration) is in
 * the core; this file only reads the tree node, connects, shows messages, and
 * focuses. Mirrors the discovery/client wiring in `./ghostexExplorer.ts`.
 */
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  deriveAgentId,
  discoverGhostex,
  GxClient,
  launchAgentForBead,
  readLinkage,
  type GhostexDiscoveryInputs,
  type LinkageRecorder,
} from '../ghostex/index.ts';
import { BeadsClient } from '../api/index.ts';
import type { BeadLeaf, BeadTreeNode } from '../beads/index.ts';
import { CONFIG_SECTION, type FeatureHost } from '../host/index.ts';

const CMD = {
  launch: 'gascityCockpit.ghostex.launchAgentForBead',
  reveal: 'gascityCockpit.ghostex.revealAgentForBead',
} as const;

/** Register the two agents-bridge commands. Invoked from the Beads explorer context menu. */
export function registerGhostexAgentBridge(host: FeatureHost): void {
  host.context.subscriptions.push(
    vscode.commands.registerCommand(CMD.launch, (node?: BeadTreeNode) => launch(host, node)),
    vscode.commands.registerCommand(CMD.reveal, (node?: BeadTreeNode) => reveal(host, node)),
  );
}

async function launch(host: FeatureHost, node?: BeadTreeNode): Promise<void> {
  const leaf = asBeadLeaf(node);
  if (!leaf) return;

  const recordLinkage = beadMetadataRecorder(host, leaf.city);
  if (!recordLinkage) {
    void vscode.window.showWarningMessage(
      'Cockpit is not connected to a city — connect first so the Ghostex linkage can be saved on the bead.',
    );
    return;
  }
  const client = await connect(host);
  if (!client) return;

  const agentId = deriveAgentId(leaf.record.bead.metadata) ?? 'agent';
  const out = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Launching ${agentId} in Ghostex…` },
    () => launchAgentForBead({ launcher: client, recordLinkage }, leaf.record.bead),
  );

  if (!out.ok) {
    void vscode.window.showErrorMessage(`Ghostex: ${out.detail}`);
    return;
  }

  const note = out.recorded ? '' : ` (warning: linkage not saved — ${out.recordError})`;
  const FOCUS = 'Focus session';
  const choice = await vscode.window.showInformationMessage(
    `Launched ${out.linkage.agentId} in Ghostex — ${out.linkage.globalRef}${note}`,
    FOCUS,
  );
  if (choice === FOCUS) await focus(client, out.linkage.sessionId, host);

  // Reflect the new linkage metadata on the bead in the explorer.
  if (out.recorded) void vscode.commands.executeCommand('gascityCockpit.beads.refresh');
}

async function reveal(host: FeatureHost, node?: BeadTreeNode): Promise<void> {
  const leaf = asBeadLeaf(node);
  if (!leaf) return;

  const linkage = readLinkage(leaf.record.bead);
  if (!linkage) {
    void vscode.window.showInformationMessage(
      'No Ghostex session is linked to this bead yet — run "Launch Agent in Ghostex" first.',
    );
    return;
  }
  const client = await connect(host);
  if (!client) return;
  await focus(client, linkage.sessionId, host);
}

// --- helpers ----------------------------------------------------------------

function asBeadLeaf(node?: BeadTreeNode): BeadLeaf | null {
  return node && node.kind === 'bead' ? node : null;
}

/** Build a linkage recorder backed by a /v0 bead-metadata merge update, or null when offline. */
function beadMetadataRecorder(host: FeatureHost, city: string): LinkageRecorder | null {
  const client = host.getClient();
  if (!client) return null;
  const beads = new BeadsClient(client, city);
  return async (beadId, metadata) => {
    const res = await beads.update(beadId, { metadata });
    return res.ok ? { ok: true } : { ok: false, detail: res.error.detail ?? res.error.title };
  };
}

/** Discover gxserver and build an RPC client, surfacing an actionable error when unavailable. */
async function connect(host: FeatureHost): Promise<GxClient | null> {
  const discovery = await discoverGhostex(discoveryInputs());
  if (discovery.state !== 'connected') {
    host.log('warn', 'ghostex agents-bridge: gxserver unavailable', { reason: discovery.reason });
    void vscode.window.showErrorMessage(`Ghostex unavailable — ${discovery.detail}`);
    return null;
  }
  return GxClient.rpc({ baseUrl: discovery.endpoint.baseUrl, token: discovery.endpoint.token });
}

async function focus(client: GxClient, sessionId: string, host: FeatureHost): Promise<void> {
  try {
    await client.focusSession({ sessionId });
  } catch (err) {
    host.log('warn', 'ghostex agents-bridge: focus failed', { sessionId, error: String(err) });
    void vscode.window.showWarningMessage(`Ghostex: could not focus session ${sessionId}.`);
  }
}

function discoveryInputs(): GhostexDiscoveryInputs {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const url = cfg.get<string>('ghostex.gxserverUrl', '').trim();
  const token = cfg.get<string>('ghostex.gxserverToken', '').trim();
  return {
    settingsUrl: url || null,
    settingsToken: token || null,
    readTokenFile: (path) => readFile(expandHome(path), 'utf8'),
  };
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~(?=$|[/\\])/, homedir()) : p;
}
