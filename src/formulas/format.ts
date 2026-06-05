// Formula preview + runs rendering (PRD user stories 30–31).
//
// Pure, provider-agnostic formatting for the TDD / workflow affordances: turn a
// compiled `FormulaDetail` into a read-only Markdown document (steps + the
// compiled DAG) and a `FormulaRuns` envelope into a runs table. Producing these
// as strings keeps the formatting testable and the VS Code glue trivial (it just
// opens the Markdown read-only, like the bead-detail document). No `vscode`.
import type { FormulaDetail, FormulaRun, FormulaRuns } from "../api/formulas";

/** Normalised lifecycle state of a formula run, derived from the raw status. */
export type RunState = "running" | "done" | "failed" | "pending" | "unknown";

/**
 * Map a raw run status string (server-defined, free-form) to a normalised state
 * the UI can icon/colour consistently. Unrecognised statuses fall through to
 * `unknown` rather than being dropped.
 */
export function runState(status: string | undefined): RunState {
  const s = (status ?? "").toLowerCase();
  if (!s) return "unknown";
  if (/(fail|error|reject|abort|cancel)/.test(s)) return "failed";
  if (/(run|progress|active|working|in[_-]?flight)/.test(s)) return "running";
  if (/(complete|done|succeed|success|closed|merged|finish)/.test(s)) return "done";
  if (/(pending|queue|open|waiting|ready|scheduled)/.test(s)) return "pending";
  return "unknown";
}

/** Display label for a run state. */
export function runStateLabel(state: RunState): string {
  switch (state) {
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "pending":
      return "Pending";
    default:
      return "Unknown";
  }
}

/** Render a formula's full detail (description, variables, steps, DAG) as Markdown. */
export function formatFormulaDetailMarkdown(detail: FormulaDetail, target?: string): string {
  const lines: string[] = [];
  lines.push(`# Formula: ${detail.name}`);
  lines.push("");
  if (target) {
    lines.push(`Compiled for **${escapeInline(target)}**.`);
    lines.push("");
  }
  lines.push(detail.description?.trim() ? detail.description.trim() : "_No description._");
  lines.push("");

  const varDefs = detail.var_defs ?? [];
  if (varDefs.length > 0) {
    lines.push("## Variables");
    lines.push("");
    lines.push("| Name | Type | Required | Default | Description |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const v of varDefs) {
      const def = v.default === undefined || v.default === null ? "—" : code(String(v.default));
      const enumNote = v.enum && v.enum.length ? ` (one of ${v.enum.map((e) => code(e)).join(", ")})` : "";
      row(lines, [code(v.name), code(v.type), v.required ? "yes" : "no", def, (v.description ?? "—") + enumNote]);
    }
    lines.push("");
  }

  const steps = detail.steps ?? [];
  lines.push("## Steps");
  lines.push("");
  if (steps.length === 0) {
    lines.push("_No steps._");
  } else {
    let i = 1;
    for (const step of steps) {
      const meta: string[] = [code(step.kind)];
      if (step.type) meta.push(`type ${code(step.type)}`);
      if (step.assignee) meta.push(`→ ${code(step.assignee)}`);
      if (step.labels && step.labels.length) meta.push(step.labels.map((l) => code(l)).join(" "));
      lines.push(`${i}. **${escapeInline(step.title)}** \`${escapeInline(step.id)}\` — ${meta.join(" · ")}`);
      i++;
    }
  }
  lines.push("");

  const edges = detail.preview?.edges ?? [];
  const nodes = detail.preview?.nodes ?? [];
  lines.push("## Compiled graph");
  lines.push("");
  if (nodes.length === 0 && edges.length === 0) {
    lines.push("_The compiled preview is empty._");
  } else {
    lines.push(`${nodes.length} node(s), ${edges.length} edge(s).`);
    lines.push("");
    // A Mermaid block for editors with Markdown-Mermaid support, plus a plain
    // edge list as a guaranteed-readable fallback.
    lines.push("```mermaid");
    lines.push("graph TD");
    for (const node of nodes) {
      lines.push(`  ${mermaidId(node.id)}["${mermaidLabel(node.title || node.id)}"]`);
    }
    for (const edge of edges) {
      const arrow = edge.kind ? `-->|${mermaidLabel(edge.kind)}|` : "-->";
      lines.push(`  ${mermaidId(edge.from)} ${arrow} ${mermaidId(edge.to)}`);
    }
    lines.push("```");
    lines.push("");
    if (edges.length > 0) {
      lines.push("Edges:");
      lines.push("");
      for (const edge of edges) {
        const verb = edge.kind ? ` (${escapeInline(edge.kind)})` : "";
        lines.push(`- ${code(edge.from)} → ${code(edge.to)}${verb}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** Render the recent runs of a formula as a read-only Markdown table. */
export function formatRunsMarkdown(runs: FormulaRuns, now: Date = new Date()): string {
  const lines: string[] = [];
  lines.push(`# Runs: ${runs.formula}`);
  lines.push("");
  lines.push(`**${runs.run_count}** total run(s).${runs.partial ? " _(list truncated)_" : ""}`);
  lines.push("");

  const recent = runs.recent_runs ?? [];
  if (recent.length === 0) {
    lines.push("_No runs yet. Kick one off from a bead to populate this._");
    lines.push("");
  } else {
    lines.push("| State | Status | Target | Workflow | Started | Updated |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const run of sortRunsNewestFirst(recent)) {
      row(lines, [
        runStateLabel(runState(run.status)),
        code(run.status || "—"),
        code(run.target || "—"),
        code(run.workflow_id || "—"),
        relativeTime(run.started_at, now),
        relativeTime(run.updated_at, now),
      ]);
    }
    lines.push("");
  }

  if (runs.partial_errors && runs.partial_errors.length) {
    lines.push("## Warnings");
    lines.push("");
    for (const err of runs.partial_errors) lines.push(`- ${escapeInline(err)}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Sort runs newest-first by `started_at` (falling back to `updated_at`). */
export function sortRunsNewestFirst(runs: FormulaRun[]): FormulaRun[] {
  return [...runs].sort((a, b) => runTime(b) - runTime(a));
}

function runTime(run: FormulaRun): number {
  const started = Date.parse(run.started_at ?? "");
  if (!Number.isNaN(started)) return started;
  const updated = Date.parse(run.updated_at ?? "");
  return Number.isNaN(updated) ? 0 : updated;
}

/** A coarse "Nm ago" / "Nh ago" relative time, or the raw value when unparseable. */
export function relativeTime(value: string | undefined, now: Date = new Date()): string {
  if (!value) return "—";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return code(value);
  const deltaMs = now.getTime() - t;
  if (deltaMs < 0) return "just now";
  const secs = Math.floor(deltaMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function row(lines: string[], cells: string[]): void {
  lines.push(`| ${cells.join(" | ")} |`);
}

function code(value: string): string {
  return "`" + value.replace(/`/g, "ʹ") + "`";
}

function escapeInline(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/** Sanitise a node id for a Mermaid graph (alnum + underscore only). */
function mermaidId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n_${cleaned}`;
}

/** Escape a Mermaid node/edge label (quotes break the bracket syntax). */
function mermaidLabel(value: string): string {
  return value.replace(/"/g, "'").replace(/[[\]]/g, "");
}
