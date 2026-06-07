/**
 * VS Code glue for Saved Views & custom dashboards (cockpit-0vi).
 *
 * Intentionally thin (PRD Testing Decisions: the editor-bound layer is small and
 * excluded from heavy unit testing). All the model — CRUD, validation,
 * persistence, the shipped defaults — lives in the tested, `vscode`-free
 * `../savedViews` core; this file maps that onto a status-bar switcher, the
 * command-palette commands, and the act of *applying* a view: it drives the Beads
 * explorer's filter over the two internal IPC commands
 * (`gascityCockpit.beads.{getViewState,applyViewState}`) and surfaces the chosen
 * panes by revealing the cockpit container and focusing them.
 *
 * Why surface (reveal/focus) rather than show/hide: VS Code has no stable API to
 * hide or reorder another feature's contributed views, and forcing a `when`
 * clause onto every pane would couple this feature to all the others (breaking the
 * parallel-merge guarantee, cockpit-1ll.15). So a saved view's pane selection is
 * applied by revealing the container and focusing the selected panes in order; the
 * full layout is still captured and persisted for forward-compatibility.
 */
import * as vscode from "vscode";
import type { GroupKey } from "../beads/index.ts";
import {
  PANES,
  createView,
  defaultPanes,
  deleteView,
  getActiveView,
  getView,
  loadState,
  renameView,
  saveState,
  setActiveView,
  updateViewContent,
  type BeadFilterSelection,
  type PaneLayout,
  type SavedView,
  type SavedViewsState,
} from "../savedViews/index.ts";

const CMD = {
  switch: "gascityCockpit.savedViews.switch",
  save: "gascityCockpit.savedViews.save",
  rename: "gascityCockpit.savedViews.rename",
  delete: "gascityCockpit.savedViews.delete",
  update: "gascityCockpit.savedViews.update",
} as const;

const BEADS_GET = "gascityCockpit.beads.getViewState";
const BEADS_APPLY = "gascityCockpit.beads.applyViewState";
const CONTAINER_FOCUS = "workbench.view.extension.gascityCockpit";

/** What the Beads explorer reports/accepts over the IPC commands. */
interface BeadViewState {
  groupBy?: GroupKey;
  filters?: Record<string, unknown>;
}

/** Register the Saved Views feature: status-bar switcher + palette commands. */
export function registerSavedViews(context: vscode.ExtensionContext): void {
  let state: SavedViewsState = loadState(context.globalState);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  statusBar.command = CMD.switch;
  context.subscriptions.push(statusBar);

  const render = (): void => {
    const active = getActiveView(state);
    statusBar.text = active ? `$(layout) ${active.name}` : "$(layout) Views";
    statusBar.tooltip = active
      ? `GasCity saved view: ${active.name}\nClick to switch`
      : "GasCity saved views — click to switch";
    statusBar.show();
  };

  const persist = async (next: SavedViewsState): Promise<void> => {
    state = next;
    await saveState(context.globalState, state);
    render();
  };

  // Persist the normalized/seeded state so globalState is authoritative from the
  // first run (seeds the built-ins durably and rewrites any corruption we cleaned
  // up on load). Then restore the active view's filter after a reload — panes are
  // left alone on startup so the cockpit doesn't yank focus on every window open.
  render();
  void saveState(context.globalState, state);
  const initial = getActiveView(state);
  if (initial) void applyFilter(initial);

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.switch, () => switchView()),
    vscode.commands.registerCommand(CMD.save, () => saveCurrent()),
    vscode.commands.registerCommand(CMD.rename, () => renameViewCmd()),
    vscode.commands.registerCommand(CMD.delete, () => deleteViewCmd()),
    vscode.commands.registerCommand(CMD.update, () => updateViewCmd()),
  );

  // --- applying ------------------------------------------------------------

  async function applyFilter(view: SavedView): Promise<void> {
    await runCommand(BEADS_APPLY, { groupBy: view.groupBy, filters: view.filters });
  }

  async function surfacePanes(panes: PaneLayout[]): Promise<void> {
    const viewIdOf = new Map(PANES.map((p) => [p.id, p.viewId]));
    await runCommand(CONTAINER_FOCUS);
    // Focus selected panes in reverse so the first listed one ends up active.
    for (const pane of [...panes].filter((p) => p.visible).reverse()) {
      const viewId = viewIdOf.get(pane.id);
      if (viewId) await runCommand(`${viewId}.focus`);
    }
  }

  async function applyView(view: SavedView): Promise<void> {
    await applyFilter(view);
    await surfacePanes(view.panes);
  }

  // --- commands ------------------------------------------------------------

  async function switchView(): Promise<void> {
    if (state.views.length === 0) {
      info("No saved views yet. Run “GasCity Views: Save Current as Saved View”.");
      return;
    }
    const active = getActiveView(state);
    const picked = await vscode.window.showQuickPick(
      state.views.map((v) => ({
        label: `$(layout) ${v.name}`,
        description: v.id === active?.id ? "active" : undefined,
        detail: describeView(v),
        id: v.id,
      })),
      { title: "Switch saved view", placeHolder: "Choose a view to apply" },
    );
    if (!picked) return;
    const view = getView(state, picked.id);
    if (!view) return;
    await persist(setActiveView(state, view.id));
    await applyView(view);
  }

  async function saveCurrent(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: "Save current as saved view",
      prompt: "Name this view (captures the current bead filter + selected panes)",
      validateInput: (v) => (v.trim() ? undefined : "Name cannot be empty"),
    });
    if (name === undefined || !name.trim()) return;

    const beads = await captureBeads();
    const panes = await pickPanes(defaultPanes());
    const { state: next, view } = createView(state, {
      name: name.trim(),
      groupBy: beads.groupBy,
      filters: beads.filters,
      panes,
    });
    await persist(setActiveView(next, view.id));
    await surfacePanes(view.panes);
    info(`Saved view “${view.name}”.`);
  }

  async function renameViewCmd(): Promise<void> {
    const view = await pickView("Rename saved view");
    if (!view) return;
    const name = await vscode.window.showInputBox({
      title: "Rename saved view",
      value: view.name,
      prompt: "New name",
      validateInput: (v) => (v.trim() ? undefined : "Name cannot be empty"),
    });
    if (name === undefined || !name.trim()) return;
    await persist(renameView(state, view.id, name.trim()));
    info(`Renamed to “${name.trim()}”.`);
  }

  async function deleteViewCmd(): Promise<void> {
    const view = await pickView("Delete saved view");
    if (!view) return;
    const choice = await vscode.window.showWarningMessage(
      `Delete saved view “${view.name}”?`,
      { modal: true },
      "Delete",
    );
    if (choice !== "Delete") return;
    await persist(deleteView(state, view.id));
    info(`Deleted “${view.name}”.`);
  }

  async function updateViewCmd(): Promise<void> {
    const view = getActiveView(state) ?? (await pickView("Update saved view to current"));
    if (!view) return;
    const beads = await captureBeads();
    const panes = await pickPanes(view.panes);
    await persist(
      updateViewContent(state, view.id, { groupBy: beads.groupBy, filters: beads.filters, panes }),
    );
    info(`Updated “${view.name}” to the current filter + panes.`);
  }

  // --- helpers -------------------------------------------------------------

  async function pickView(title: string): Promise<SavedView | undefined> {
    if (state.views.length === 0) {
      info("No saved views yet.");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      state.views.map((v) => ({ label: v.name, detail: describeView(v), id: v.id })),
      { title },
    );
    return picked ? getView(state, picked.id) : undefined;
  }

  async function pickPanes(current: PaneLayout[]): Promise<PaneLayout[]> {
    const visible = new Set(current.filter((p) => p.visible).map((p) => p.id));
    const picked = await vscode.window.showQuickPick(
      PANES.map((p) => ({ label: p.label, id: p.id, picked: visible.has(p.id) })),
      { canPickMany: true, title: "Panes in this view", placeHolder: "Select the panes this view surfaces" },
    );
    if (!picked) return current;
    const chosen = new Set(picked.map((p) => p.id));
    return PANES.map((p) => ({ id: p.id, visible: chosen.has(p.id) }));
  }

  async function captureBeads(): Promise<{ groupBy?: GroupKey; filters: BeadFilterSelection }> {
    let raw: unknown;
    try {
      raw = await vscode.commands.executeCommand(BEADS_GET);
    } catch {
      raw = undefined;
    }
    return toSelection(raw);
  }
}

/** Execute a command, swallowing a rejection (the target view/command may be absent). */
function runCommand(command: string, ...args: unknown[]): Promise<void> {
  return Promise.resolve(vscode.commands.executeCommand(command, ...args)).then(
    () => undefined,
    () => undefined,
  );
}

/** Pull a saved-view filter selection out of the Beads explorer's reported state. */
function toSelection(raw: unknown): { groupBy?: GroupKey; filters: BeadFilterSelection } {
  if (!raw || typeof raw !== "object") return { filters: {} };
  const state = raw as BeadViewState;
  const f = state.filters ?? {};
  const filters: BeadFilterSelection = {};
  if (typeof f.text === "string" && f.text.trim()) filters.text = f.text;
  if (Array.isArray(f.status)) {
    const status = f.status.filter((s): s is string => typeof s === "string");
    if (status.length > 0) filters.status = status;
  }
  if (typeof f.rig === "string") filters.rig = f.rig;
  if (typeof f.assignee === "string") filters.assignee = f.assignee;
  if (typeof f.type === "string") filters.type = f.type;
  if (typeof f.priority === "number") filters.priority = f.priority;
  const groupBy = typeof state.groupBy === "string" ? (state.groupBy as GroupKey) : undefined;
  return groupBy ? { groupBy, filters } : { filters };
}

/** A one-line summary of a view's grouping, filters, and pane count for quick-picks. */
function describeView(view: SavedView): string {
  const parts: string[] = [];
  if (view.groupBy) parts.push(`by ${view.groupBy}`);
  const f = view.filters;
  if (f.status?.length) parts.push(`status: ${f.status.join("/")}`);
  if (f.rig) parts.push(`rig: ${f.rig}`);
  if (f.assignee !== undefined) parts.push(`assignee: ${f.assignee || "(unassigned)"}`);
  if (f.type) parts.push(`type: ${f.type}`);
  if (f.priority !== undefined) parts.push(`P${f.priority}`);
  if (f.text) parts.push(`“${f.text}”`);
  const panes = view.panes.filter((p) => p.visible).length;
  parts.push(`${panes} pane${panes === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function info(message: string): void {
  void vscode.window.showInformationMessage(message);
}
