/**
 * VS Code glue for the TDD / formula affordances (PRD stories 30–31).
 *
 * Thin by design: the rendering + run-state logic lives in the tested,
 * `vscode`-free `../formulas` core and the typed `FormulasClient` (Seam 1). This
 * file maps those onto three commands —
 *
 *   - Preview a formula (read-only Markdown of its steps + compiled DAG).
 *   - Kick off the `tdd` formula on a bead (a dispatch via `BeadsClient.sling`,
 *     after showing the operator the compiled preview).
 *   - Watch a formula's recent runs (read-only Markdown, auto-refreshing).
 *
 * Formula detail/runs are served through a `TextDocumentContentProvider`, so the
 * documents are read-only and re-fetch from the live API whenever refreshed.
 */
import * as vscode from "vscode";
import {
  BeadsClient,
  FormulasClient,
  type CockpitClient,
  type FormulaDetail,
} from "../api/index.ts";
import { BeadsApiError, beadRig, type BeadsRepository, type BeadTreeNode } from "../beads/index.ts";
import { formatFormulaDetailMarkdown, formatRunsMarkdown } from "../formulas/index.ts";

const SCHEME = "gascity-formula";
const TDD_FORMULA = "tdd";
/** How often the runs view refreshes while watching, and for how long. */
const RUNS_REFRESH_MS = 4_000;
const RUNS_WATCH_MAX_MS = 5 * 60_000;

const CMD = {
  preview: "gascityCockpit.formulas.preview",
  showRuns: "gascityCockpit.formulas.showRuns",
  runTdd: "gascityCockpit.beads.runTdd",
} as const;

export interface FormulaFlowsDeps {
  /** Client for the currently-connected supervisor, or null when unavailable. */
  getClient: () => CockpitClient | null;
  repository: BeadsRepository;
  log: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

/** A `{kind}` of formula document the content provider can render. */
type DocKind = "detail" | "runs";

/**
 * Read-only content provider for formula detail and runs Markdown. The URI query
 * carries the city / formula / target, so a refresh re-fetches from the live API
 * — that is what makes the runs view a "watch" (story 31).
 */
class FormulaContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly getClient: () => CockpitClient | null) {}

  refresh(uri: vscode.Uri): void {
    this.emitter.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const kind = (params.get("kind") ?? "detail") as DocKind;
    const city = params.get("city") ?? "";
    const name = params.get("name") ?? "";
    const target = params.get("target") ?? "";

    const client = this.getClient();
    if (!client) return `# ${name}\n\n> Not connected to a supervisor API.\n`;
    const formulas = new FormulasClient(client, city);

    if (kind === "runs") {
      const result = await formulas.runs(name, { limit: 25 });
      if (!result.ok) return `# Runs: ${name}\n\n> Failed to load runs: ${result.error.title}\n`;
      return formatRunsMarkdown(result.data);
    }

    const result = await formulas.get(name, target);
    if (!result.ok) return `# Formula: ${name}\n\n> Failed to load formula: ${result.error.title}\n`;
    return formatFormulaDetailMarkdown(result.data, target);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function docUri(kind: DocKind, city: string, name: string, target: string): vscode.Uri {
  const query = new URLSearchParams({ kind, city, name, target });
  const suffix = kind === "runs" ? "runs" : "formula";
  return vscode.Uri.from({ scheme: SCHEME, path: `/${name}.${suffix}.md`, query: query.toString() });
}

async function openMarkdown(uri: vscode.Uri): Promise<void> {
  await Promise.resolve(vscode.commands.executeCommand("markdown.showPreview", uri)).then(undefined, async () => {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  });
}

/**
 * Manages the auto-refresh timers behind the "watch runs" experience: one timer
 * per open runs document, stopped when the document closes or after a cap so a
 * forgotten preview cannot poll forever.
 */
class RunsWatcher {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly provider: FormulaContentProvider) {}

  watch(uri: vscode.Uri): void {
    const key = uri.toString();
    this.stop(key);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > RUNS_WATCH_MAX_MS) {
        this.stop(key);
        return;
      }
      this.provider.refresh(uri);
    }, RUNS_REFRESH_MS);
    this.timers.set(key, timer);
  }

  onDocClosed(uri: vscode.Uri): void {
    this.stop(uri.toString());
  }

  private stop(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(key);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}

/** Pick a city: auto-select the only running one, else prompt. */
async function pickCity(deps: FormulaFlowsDeps): Promise<string | null> {
  let cities: { name: string; running: boolean }[];
  try {
    cities = await deps.repository.listCities();
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not list cities: ${err instanceof BeadsApiError ? err.message : String(err)}`);
    return null;
  }
  const running = cities.filter((c) => c.running);
  if (running.length === 0) {
    void vscode.window.showWarningMessage("No running cities to read formulas from.");
    return null;
  }
  if (running.length === 1) return running[0].name;
  const picked = await vscode.window.showQuickPick(
    running.map((c) => ({ label: c.name })),
    { title: "Select a city" },
  );
  return picked?.label ?? null;
}

/** Pick a formula by name from a city's formula list. */
async function pickFormula(client: CockpitClient, city: string): Promise<string | null> {
  const formulas = new FormulasClient(client, city);
  const result = await formulas.list();
  if (!result.ok) {
    void vscode.window.showErrorMessage(`Could not list formulas: ${result.error.title}`);
    return null;
  }
  const items = (result.data.items ?? []).map((f) => ({
    label: f.name,
    description: `${f.run_count} run(s)`,
    detail: f.description,
  }));
  if (items.length === 0) {
    void vscode.window.showInformationMessage(`No formulas registered in ${city}.`);
    return null;
  }
  const picked = await vscode.window.showQuickPick(items, { title: `Formulas in ${city}`, matchOnDetail: true });
  return picked?.label ?? null;
}

/** Prompt for the target agent/pool a formula compiles/runs against. */
async function promptTarget(prefill: string, formulaName: string): Promise<string | null> {
  const value = await vscode.window.showInputBox({
    title: `Target for "${formulaName}"`,
    prompt: "Agent or pool the formula compiles/runs against",
    value: prefill,
    validateInput: (v) => (v.trim() ? null : "Target is required"),
  });
  return value?.trim() || null;
}

/** Variable values the formula declares and we can supply (currently `bead`). */
function varsForBead(detail: FormulaDetail, beadId: string): Record<string, string> | undefined {
  const declaresBead = (detail.var_defs ?? []).some((v) => v.name === "bead");
  return declaresBead ? { bead: beadId } : undefined;
}

export function registerFormulaFlows(context: vscode.ExtensionContext, deps: FormulaFlowsDeps): void {
  const provider = new FormulaContentProvider(deps.getClient);
  const watcher = new RunsWatcher(provider);

  const openRuns = async (city: string, name: string): Promise<void> => {
    const uri = docUri("runs", city, name, "");
    provider.refresh(uri);
    await openMarkdown(uri);
    watcher.watch(uri);
  };

  context.subscriptions.push(
    provider,
    { dispose: () => watcher.dispose() },
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === SCHEME) watcher.onDocClosed(doc.uri);
    }),

    // Preview any formula (palette): pick city → formula → target → render.
    vscode.commands.registerCommand(CMD.preview, async () => {
      const client = deps.getClient();
      if (!client) return void vscode.window.showWarningMessage("Not connected to a supervisor API.");
      const city = await pickCity(deps);
      if (!city) return;
      const name = await pickFormula(client, city);
      if (!name) return;
      const target = await promptTarget(`${city}/gastown.polecat`, name);
      if (!target) return;
      await openMarkdown(docUri("detail", city, name, target));
    }),

    // Watch a formula's runs (palette): pick city → formula → render + watch.
    vscode.commands.registerCommand(CMD.showRuns, async () => {
      const client = deps.getClient();
      if (!client) return void vscode.window.showWarningMessage("Not connected to a supervisor API.");
      const city = await pickCity(deps);
      if (!city) return;
      const name = await pickFormula(client, city);
      if (!name) return;
      await openRuns(city, name);
    }),

    // Kick off TDD on a bead (bead context menu): preview → confirm → sling →
    // offer to watch runs.
    vscode.commands.registerCommand(CMD.runTdd, async (node?: BeadTreeNode) => {
      if (!node || node.kind !== "bead") {
        return void vscode.window.showInformationMessage("Run this from a bead in the Beads explorer.");
      }
      const client = deps.getClient();
      if (!client) return void vscode.window.showWarningMessage("Not connected to a supervisor API.");
      const { city, beadId } = node;

      let rig = "";
      try {
        rig = beadRig(await deps.repository.getBead(city, beadId));
      } catch {
        // Non-fatal: fall back to a generic pool prefix in the prompt.
      }
      const target = await promptTarget(`${rig || city}/gastown.polecat`, TDD_FORMULA);
      if (!target) return;

      const formulas = new FormulasClient(client, city);
      const preview = await formulas.preview(TDD_FORMULA, { target, vars: { bead: beadId } });
      if (!preview.ok) {
        return void vscode.window.showErrorMessage(`Could not preview ${TDD_FORMULA}: ${preview.error.title}`);
      }
      await openMarkdown(docUri("detail", city, TDD_FORMULA, target));

      const go = await vscode.window.showInformationMessage(
        `Kick off "${TDD_FORMULA}" on ${beadId} → ${target}?`,
        { modal: true },
        "Run",
      );
      if (go !== "Run") return;

      const beads = new BeadsClient(client, city);
      const vars = varsForBead(preview.data, beadId);
      const sling = await beads.sling({
        bead: beadId,
        target,
        formula: TDD_FORMULA,
        ...(vars ? { vars } : {}),
      });
      if (!sling.ok) {
        return void vscode.window.showErrorMessage(`Failed to start ${TDD_FORMULA}: ${sling.error.title}`);
      }
      deps.log("info", `slung ${TDD_FORMULA} onto ${beadId} → ${target} (workflow ${sling.data.workflow_id ?? "?"})`);
      const watch = await vscode.window.showInformationMessage(
        `Started ${TDD_FORMULA} on ${beadId}.`,
        "Watch Runs",
      );
      if (watch === "Watch Runs") await openRuns(city, TDD_FORMULA);
    }),
  );
}
