/**
 * VS Code glue for event time-travel (cockpit-21l.6).
 *
 * Intentionally thin (PRD Testing Decisions: the editor-bound layer is not unit
 * tested). All the behaviour worth testing — recording, de-dup, projection, and
 * the scrubber document — lives in the `vscode`-free `../timetravel` core and its
 * pure HTML builder. This file owns a `WebviewPanel`, posts the recorded rows in,
 * forwards live appends from the recorder, and services the webview's `copy`
 * request. The replay/scrub interaction runs entirely in the webview.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  buildTimelineView,
  captureTimelineScenario,
  renderTimeTravelHtml,
  serializeScenario,
  type EventTimeline,
} from '../timetravel/index.ts';
import type { FleetEvent } from '../status/index.ts';

const OPEN_COMMAND = 'gascityCockpit.timeTravel.open';
const TITLE = 'Event Time-Travel';

export interface TimeTravelDeps {
  /** The background recorder the feature keeps filling from the event stream. */
  timeline: EventTimeline;
}

/** Register the `Event Time-Travel…` command. The panel is created lazily on first open. */
export function registerTimeTravel(context: vscode.ExtensionContext, deps: TimeTravelDeps): void {
  const panel = new TimeTravelPanel(deps.timeline);
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_COMMAND, () => panel.show()),
    { dispose: () => panel.dispose() },
  );
}

/** A 32-char alphanumeric nonce locking the webview's inline script to this load. */
function makeNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (const byte of randomBytes(32)) out += alphabet[byte % alphabet.length];
  return out;
}

/** Turn a scenario name into a safe lowercase-kebab filename stem. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'replay';
}

/**
 * A single, reused webview panel showing the recorded timeline. Opening it again
 * reveals the existing panel rather than spawning a second. While open it follows
 * the recorder's `onDidRecord` so new events stream into the scrubber live.
 */
class TimeTravelPanel {
  private panel: vscode.WebviewPanel | null = null;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly timeline: EventTimeline) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'gascityCockpit.timeTravel',
      TITLE,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel = panel;
    panel.webview.html = renderTimeTravelHtml({
      nonce: makeNonce(),
      cspSource: panel.webview.cspSource,
      title: TITLE,
    });
    this.subs.push(
      panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m)),
      this.timeline.onDidRecord((e) => this.append(e)),
      panel.onDidDispose(() => this.teardown()),
    );
  }

  private append(event: FleetEvent): void {
    const [row] = buildTimelineView([event]);
    void this.panel?.webview.postMessage({ type: 'append', row });
  }

  private onMessage(raw: unknown): void {
    const msg = raw as { type?: string; text?: string };
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ready') {
      void this.panel?.webview.postMessage({ type: 'timeline', rows: this.timeline.snapshot().rows });
    } else if (msg.type === 'copy' && typeof msg.text === 'string') {
      void vscode.env.clipboard.writeText(msg.text);
      void vscode.window.showInformationMessage('Event copied to clipboard.');
    } else if (msg.type === 'saveScenario') {
      void this.saveScenario();
    }
  }

  /**
   * Capture the live recording as a replay-to-regression scenario and write it to
   * a JSON fixture the operator chooses. The capture + serialization is the
   * tested `../timetravel` core; this method is only the editor-bound prompt/save
   * flow. Defaults the save location to the repo's `src/timetravel/scenarios/`
   * (where the regression suite loads them) when a workspace is open.
   */
  private async saveScenario(): Promise<void> {
    if (this.timeline.size === 0) {
      void vscode.window.showInformationMessage('No events recorded yet — nothing to save as a scenario.');
      return;
    }
    const bounds = this.timeline.bounds();
    const suggested = bounds ? `replay-seq${bounds.firstSeq}-${bounds.lastSeq}` : 'replay';
    const name = await vscode.window.showInputBox({
      title: 'Save replay as regression scenario',
      prompt: 'Name this scenario — its stable identity in the regression suite.',
      value: suggested,
      validateInput: (v) => (v.trim().length === 0 ? 'Enter a non-empty name.' : undefined),
    });
    if (name === undefined) return; // cancelled

    const scenario = captureTimelineScenario(this.timeline, name.trim(), {
      capturedAt: new Date().toISOString(),
    });
    const json = serializeScenario(scenario);

    const fileName = `${slugify(name.trim())}.scenario.json`;
    const folder = vscode.workspace.workspaceFolders?.[0];
    const defaultUri = folder
      ? vscode.Uri.joinPath(folder.uri, 'src', 'timetravel', 'scenarios', fileName)
      : vscode.Uri.file(fileName);
    const target = await vscode.window.showSaveDialog({
      title: 'Save replay scenario',
      defaultUri,
      filters: { 'Replay scenario': ['json'] },
    });
    if (!target) return; // cancelled

    try {
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(json));
      void vscode.window.showInformationMessage(
        `Saved replay scenario "${scenario.name}" (${scenario.expected.rows.length} events). Add it to src/timetravel/scenarios/index.ts to run it in the regression suite.`,
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to save replay scenario: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private teardown(): void {
    for (const s of this.subs.splice(0)) s.dispose();
    this.panel = null;
  }

  dispose(): void {
    const panel = this.panel;
    this.teardown();
    panel?.dispose();
  }
}
