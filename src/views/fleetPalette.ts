/**
 * VS Code glue for the fleet command palette (cockpit-21l.1).
 *
 * Intentionally thin (PRD Testing Decisions: the editor-bound layer is not unit
 * tested). All the behaviour worth testing — turning a plain-language string into
 * a structured query and running it across cities — lives in the `vscode`-free
 * `../fleet` core. This file is just the omnibox: a `QuickPick` whose typed value
 * is re-parsed on every keystroke (`alwaysShow` keeps every computed result
 * visible rather than letting VS Code filter by the raw query text), with the
 * interpretation echoed in the title and selection handed to the beads detail
 * view.
 */
import * as vscode from "vscode";
import {
  BeadsRepository,
  displayStatusLabel,
  priorityLabel,
  type BeadLeaf,
  type ExplorerData,
} from "../beads/index.ts";
import { parseFleetQuery, runFleetQuery, type FleetResultRow } from "../fleet/index.ts";

const CMD_OPEN = "gascityCockpit.fleetQuery.open";
/** Reuse the beads explorer's detail renderer rather than duplicating it. */
const BEADS_OPEN_DETAIL = "gascityCockpit.beads.openDetail";
/** Cap rendered rows so a broad query stays responsive; the count is surfaced. */
const MAX_ITEMS = 200;
const EXAMPLES = 'e.g. "blocked beads in cockpit" · "failing features" · "p0 across all cities" · "unassigned tasks"';

const STATUS_CODICON: Record<string, string> = {
  in_progress: "play-circle",
  ready: "circle-large-outline",
  blocked: "error",
  open: "circle-outline",
  deferred: "clock",
  escalated: "warning",
  closed: "pass-filled",
};

export interface FleetPaletteDeps {
  repository: BeadsRepository;
}

interface FleetPickItem extends vscode.QuickPickItem {
  /** The result row this item opens, or absent for informational rows. */
  row?: FleetResultRow;
}

/** Register the `Query Fleet…` command. Loads data on demand — no connection wiring. */
export function registerFleetPalette(context: vscode.ExtensionContext, deps: FleetPaletteDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_OPEN, () => void openPalette(deps.repository)),
  );
}

async function openPalette(repository: BeadsRepository): Promise<void> {
  const qp = vscode.window.createQuickPick<FleetPickItem>();
  qp.title = "Fleet Query";
  qp.placeholder = "Loading beads across all cities…";
  qp.busy = true;
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.show();

  let data: ExplorerData;
  try {
    // Pull closed beads too so "closed/done" queries work; the parser decides
    // per-query whether to show them (filterRecords hides closed by default).
    data = await repository.loadExplorer({ includeClosed: true });
  } catch (err) {
    qp.hide();
    qp.dispose();
    void vscode.window.showErrorMessage(`Fleet query — could not load beads: ${errorText(err)}`);
    return;
  }

  qp.busy = false;
  qp.placeholder = EXAMPLES;

  const render = (value: string): void => {
    const parsed = parseFleetQuery(value);
    const result = runFleetQuery(data, parsed.query);
    qp.title = `Fleet Query — ${parsed.summary}`;

    const items: FleetPickItem[] = result.rows.slice(0, MAX_ITEMS).map(toItem);
    if (result.rows.length > MAX_ITEMS) {
      items.push({ label: `$(ellipsis) ${result.rows.length - MAX_ITEMS} more — refine your query`, alwaysShow: true });
    }
    qp.items = items;

    if (!value.trim()) {
      qp.placeholder = EXAMPLES;
    } else if (result.unknownCity) {
      qp.placeholder = `No city matches "${result.unknownCity}" — try a city name or "all cities"`;
    } else if (result.rows.length === 0) {
      const hint = parsed.unmatched.length > 0 ? ` (didn't understand: ${parsed.unmatched.join(", ")})` : "";
      qp.placeholder = `No matching beads${hint}`;
    } else {
      const shown = Math.min(result.rows.length, MAX_ITEMS);
      const suffix = result.rows.length > shown ? ` (showing ${shown})` : "";
      qp.placeholder = `${result.totalMatched} ${result.totalMatched === 1 ? "match" : "matches"}${suffix} · Enter to open`;
    }
  };

  render(qp.value);
  const changeSub = qp.onDidChangeValue(render);

  qp.onDidAccept(() => {
    const picked = qp.selectedItems[0];
    qp.hide();
    if (picked?.row) void openBeadDetail(picked.row);
  });
  qp.onDidHide(() => {
    changeSub.dispose();
    qp.dispose();
  });
}

function toItem(row: FleetResultRow): FleetPickItem {
  const bead = row.record.bead;
  const icon = STATUS_CODICON[row.displayStatus] ?? "circle-outline";
  return {
    label: bead.id,
    description: bead.title ?? "",
    detail: `$(${icon}) ${displayStatusLabel(row.displayStatus)} · ${priorityLabel(bead.priority)} · ${row.city}`,
    alwaysShow: true,
    row,
  };
}

async function openBeadDetail(row: FleetResultRow): Promise<void> {
  const leaf: BeadLeaf = {
    kind: "bead",
    id: `bead:${row.city}:${row.record.bead.id}`,
    city: row.city,
    beadId: row.record.bead.id,
    record: row.record,
    displayStatus: row.displayStatus,
  };
  try {
    await vscode.commands.executeCommand(BEADS_OPEN_DETAIL, leaf);
  } catch {
    // Beads explorer unavailable — degrade to a copyable notice rather than fail.
    await vscode.env.clipboard.writeText(row.record.bead.id);
    void vscode.window.showInformationMessage(`${row.record.bead.id} — ${row.record.bead.title ?? ""} (id copied)`);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
