// VS Code glue for "file a bead from a code selection" (cockpit-21l.4).
//
// Thin by design (PRD Testing Decisions: the editor-bound layer is excluded from
// unit testing). It captures the active selection, picks a city, and creates a
// bead through the authoring client; the testable shaping of the bead payload
// lives in the vscode-free `../beads/from-selection` core. City selection reuses
// the pure picker helpers (running cities first, the workspace's city floated up)
// and falls back to a text box when the supervisor can't be listed.
import * as vscode from "vscode";
import * as path from "node:path";
import { BeadsClient, listCities, type CockpitClient } from "../api/index.ts";
import {
  buildBeadInput,
  formatLocation,
  suggestTitle,
  type CodeSelectionContext,
} from "../beads/index.ts";
import { cityPickLabel, rankCitiesForPicker } from "../chat/city-picker.ts";
import type { Logger } from "../discovery/index.ts";

const COMMAND = "gascityCockpit.beads.newFromSelection";
const TITLE = "New Bead from Selection";

export interface NewBeadFromSelectionDeps {
  /** The live client for the connected supervisor, or null when disconnected. */
  getClient: () => CockpitClient | null;
  log: Logger;
}

/** Register the editor command that files a bead from the active selection. */
export function registerNewBeadFromSelection(
  context: vscode.ExtensionContext,
  deps: NewBeadFromSelectionDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND, () => fileBeadFromSelection(deps)),
  );
}

async function fileBeadFromSelection(deps: NewBeadFromSelectionDeps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage(
      "Open a file and put the cursor in (or select) the code to file a bead from it.",
    );
    return;
  }

  const client = deps.getClient();
  if (!client) {
    void vscode.window.showWarningMessage("Not connected to a supervisor API — can't create a bead.");
    return;
  }

  const selection = captureSelection(editor);

  const title = await vscode.window.showInputBox({
    title: TITLE,
    prompt: `Title for the bead — ${formatLocation(selection)} is attached automatically`,
    value: suggestTitle(selection),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length > 0 ? undefined : "A title is required"),
  });
  if (!title || !title.trim()) return;

  const cityName = await pickCity(client, deps.log);
  if (!cityName) return;

  const beads = new BeadsClient(client, cityName);
  const result = await beads.create(buildBeadInput(selection, title.trim()));
  if (!result.ok) {
    void vscode.window.showErrorMessage(`Couldn't file the bead: ${result.error.title}`);
    return;
  }

  const { id } = result.data;
  deps.log("info", `filed bead ${id} in ${cityName} from ${formatLocation(selection)}`);
  await vscode.commands.executeCommand("gascityCockpit.beads.refresh");
  const action = await vscode.window.showInformationMessage(`Filed ${id} in ${cityName}.`, "Copy ID");
  if (action === "Copy ID") await vscode.env.clipboard.writeText(id);
}

/**
 * Capture the active selection as a vscode-free {@link CodeSelectionContext}.
 * With nothing selected, the caret's whole line is used. A multi-line selection
 * that ends at column 0 doesn't really include that last line (matching how a
 * `file:line` range reads), so it isn't counted.
 */
function captureSelection(editor: vscode.TextEditor): CodeSelectionContext {
  const sel = editor.selection;
  const startLine = sel.start.line + 1;
  const endsAtLineStart = sel.end.character === 0 && sel.end.line > sel.start.line;
  const endLine = endsAtLineStart ? sel.end.line : sel.end.line + 1;
  const selectedText = sel.isEmpty
    ? editor.document.lineAt(sel.start.line).text
    : editor.document.getText(sel);
  return {
    file: vscode.workspace.asRelativePath(editor.document.uri, false),
    startLine,
    endLine,
    selectedText,
    languageId: editor.document.languageId,
  };
}

/**
 * Pick the city to file the bead in. Lists the supervisor's cities (running
 * first, the open workspace's city floated to the top) in a QuickPick; falls back
 * to a text box when the supervisor can't be listed or knows of no cities.
 */
async function pickCity(client: CockpitClient, log: Logger): Promise<string | undefined> {
  const result = await listCities(client);
  if (!result.ok) {
    log("warn", `new bead: could not list cities: ${result.error.title}`);
    return promptCityName("Couldn't list cities — enter a city name");
  }

  const cities = result.data.items ?? [];
  if (cities.length === 0) return promptCityName("No cities registered — enter a city name");

  const pick = await vscode.window.showQuickPick(
    rankCitiesForPicker(cities, workspaceCityName()).map(cityPickLabel),
    {
      title: `${TITLE} — City`,
      placeHolder: "Select the city to file the bead in (running cities first)",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  return pick?.name;
}

/** The open workspace folder's basename — a good default city guess. */
function workspaceCityName(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && folder.uri.scheme === "file" ? path.basename(folder.uri.fsPath) : "";
}

async function promptCityName(prompt: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: `${TITLE} — City`,
    prompt,
    value: workspaceCityName(),
    ignoreFocusOut: true,
  });
  return value?.trim() || undefined;
}
