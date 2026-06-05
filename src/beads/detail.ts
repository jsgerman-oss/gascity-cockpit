// Render a bead's full detail as Markdown (PRD story 10).
//
// The output is shown read-only in a Markdown preview; producing it as a pure
// string keeps the formatting testable and the VS Code glue trivial. Only the
// fields the /v0 contract actually exposes are rendered — comments and edit
// history are not part of the /v0 Bead shape, so they are noted, not faked.
import type { BeadRecord } from "./types.ts";
import { beadRig, deriveDisplayStatus, displayStatusLabel, priorityLabel } from "./status.ts";

export function formatBeadDetailMarkdown(record: BeadRecord, now: Date = new Date()): string {
  const bead = record.bead;
  const status = deriveDisplayStatus(record, now);
  const lines: string[] = [];

  lines.push(`# ${bead.id} — ${bead.title ?? "(untitled)"}`);
  lines.push("");
  lines.push(
    `**${displayStatusLabel(status)}** · ${escapeInline(bead.issue_type ?? "untyped")} · ` +
      `${priorityLabel(bead.priority)}`,
  );
  lines.push("");

  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  row(lines, "City", code(record.city));
  row(lines, "Raw status", code(bead.status ?? "—"));
  row(lines, "Rig", code(beadRig(bead)));
  row(lines, "Assignee", bead.assignee ? code(bead.assignee) : "_unassigned_");
  if (bead.parent) row(lines, "Parent", code(bead.parent));
  if (bead.ref) row(lines, "Ref", code(bead.ref));
  if (bead.ephemeral) row(lines, "Ephemeral", "yes");
  if (bead.labels && bead.labels.length > 0) {
    row(lines, "Labels", bead.labels.map((l) => code(l)).join(" "));
  }
  row(lines, "Created", formatTimestamp(bead.created_at));
  if (bead.updated_at) row(lines, "Updated", formatTimestamp(bead.updated_at));
  if (bead.defer_until) row(lines, "Deferred until", formatTimestamp(bead.defer_until));
  lines.push("");

  lines.push("## Description");
  lines.push("");
  lines.push(bead.description?.trim() ? bead.description.trim() : "_No description._");
  lines.push("");

  lines.push("## Dependencies");
  lines.push("");
  const deps = bead.dependencies ?? [];
  if (deps.length === 0) {
    lines.push("_No dependencies._");
  } else {
    for (const dep of deps) {
      const verb = dep.type ? `${escapeInline(dep.type)} → ` : "→ ";
      lines.push(`- ${verb}${code(dep.depends_on_id)}`);
    }
  }
  lines.push("");

  const metaEntries = Object.entries(bead.metadata ?? {});
  if (metaEntries.length > 0) {
    lines.push("## Metadata");
    lines.push("");
    lines.push("| Key | Value |");
    lines.push("| --- | --- |");
    for (const [key, value] of metaEntries.sort(([a], [b]) => a.localeCompare(b))) {
      row(lines, code(key), value ? code(value) : "—");
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("> Comments and edit history are not exposed by the /v0 bead contract.");
  lines.push("");

  return lines.join("\n");
}

function row(lines: string[], key: string, value: string): void {
  lines.push(`| ${key} | ${value} |`);
}

function code(value: string): string {
  return "`" + value.replace(/`/g, "ʹ") + "`";
}

function escapeInline(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function formatTimestamp(value?: string): string {
  if (!value) return "—";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return code(value);
  return new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
