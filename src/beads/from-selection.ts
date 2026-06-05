// Build a bead-create payload from a captured code selection (vscode-free core).
//
// The "file a bead from a code selection" feature (cockpit-21l.4) right-clicks a
// selection in the editor and opens a new bead with the file:line context
// auto-attached. The editor-bound capture — reading the active selection, the
// city QuickPick, the create call — is thin glue in
// `../views/newBeadFromSelection.ts`; the part worth testing, turning a location
// plus snippet into a `BeadCreateInput` with a readable description and
// structured provenance metadata, lives here and imports no `vscode` (PRD
// Testing Decisions, Seam 1; the contributing-features guardrail keeps testable
// logic vscode-free).
import type { BeadCreateInput } from "../api/index.ts";

/**
 * A code selection captured from the editor, expressed without any `vscode`
 * types so the bead-building logic is unit-testable. Lines are 1-based and
 * inclusive, matching how editors and `file:line` references read.
 */
export interface CodeSelectionContext {
  /** File path to show in the bead — workspace-relative when possible. */
  file: string;
  /** 1-based first line of the selection (the caret line when nothing is selected). */
  startLine: number;
  /** 1-based last line, inclusive (equals `startLine` for a single line). */
  endLine: number;
  /** The selected source text (the caret's whole line when nothing is selected). */
  selectedText: string;
  /** VS Code language id, used to tag the fenced snippet (e.g. `"typescript"`). */
  languageId?: string;
}

/** Metadata key recording the source file a bead was filed from. */
export const SOURCE_FILE_KEY = "cockpit.source_file";
/** Metadata key recording the source line range (`"10"` or `"10-20"`). */
export const SOURCE_LINES_KEY = "cockpit.source_lines";

/** Cap the attached snippet so selecting a whole file can't bloat the bead. */
export const MAX_SNIPPET_LINES = 80;

/** The line range as it reads in a `file:line` reference: `"10"` or `"10-20"`. */
export function lineRange(ctx: CodeSelectionContext): string {
  return ctx.endLine > ctx.startLine ? `${ctx.startLine}-${ctx.endLine}` : `${ctx.startLine}`;
}

/** A `path:line` location reference, e.g. `"src/foo.ts:10-20"`. */
export function formatLocation(ctx: CodeSelectionContext): string {
  return `${ctx.file}:${lineRange(ctx)}`;
}

/**
 * A default bead title: the location reference. It is stable and unambiguous,
 * and the operator is prompted to refine it; the snippet itself lands in the
 * body, not the title.
 */
export function suggestTitle(ctx: CodeSelectionContext): string {
  return formatLocation(ctx);
}

/**
 * The auto-attached description body: the source location followed by the
 * selected snippet in a fenced block. The fence is widened past any backtick run
 * inside the snippet so embedded code fences can't break out of the block, and a
 * very large selection is clamped to {@link MAX_SNIPPET_LINES}. A blank or
 * whitespace-only selection yields the location alone.
 */
export function buildSelectionDescription(ctx: CodeSelectionContext): string {
  const parts = [`**Source:** \`${formatLocation(ctx)}\``];
  const { body, omitted } = clampSnippet(ctx.selectedText);
  if (body.trim().length > 0) {
    const fence = fenceFor(body);
    parts.push(`${fence}${ctx.languageId ?? ""}\n${body}\n${fence}`);
    if (omitted > 0) parts.push(`_…${omitted} more line${omitted === 1 ? "" : "s"} not shown._`);
  }
  return parts.join("\n\n");
}

/**
 * Assemble the `create` payload: the operator's title, the auto-attached
 * description, and provenance metadata so the bead's origin stays
 * machine-readable (not only embedded in the prose body).
 */
export function buildBeadInput(ctx: CodeSelectionContext, title: string): BeadCreateInput {
  return {
    title,
    description: buildSelectionDescription(ctx),
    metadata: {
      [SOURCE_FILE_KEY]: ctx.file,
      [SOURCE_LINES_KEY]: lineRange(ctx),
    },
  };
}

/** Trim trailing blank lines and clamp to {@link MAX_SNIPPET_LINES}. */
function clampSnippet(text: string): { body: string; omitted: number } {
  const lines = text.replace(/\s+$/, "").split("\n");
  if (lines.length <= MAX_SNIPPET_LINES) return { body: lines.join("\n"), omitted: 0 };
  return { body: lines.slice(0, MAX_SNIPPET_LINES).join("\n"), omitted: lines.length - MAX_SNIPPET_LINES };
}

/** A backtick fence at least 3 long and longer than any backtick run in `text`. */
function fenceFor(text: string): string {
  let max = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, max + 1));
}
