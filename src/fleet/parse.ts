// Natural-language → structured query for the fleet palette (cockpit-21l.1).
//
// `parseFleetQuery` is a deterministic, dictionary-driven resolver — not a model
// call. It recognises a small, documented vocabulary (status words, types,
// priorities, assignee, a city scope, a result cap, quoted/"matching" text) and
// folds whatever it finds into a {@link FleetQuery}. Everything it understands is
// echoed back through `summary`; everything it does not is surfaced in
// `unmatched`. Being pure and free of `vscode`, the whole grammar is unit-tested
// (PRD Seam 1) — the value of an NL bar is that its interpretation is provable.
import { displayStatusLabel, priorityLabel } from "../beads/index.ts";
import type { BeadFilters, DisplayStatus } from "../beads/index.ts";
import type { FleetQuery, ParsedFleetQuery } from "./types.ts";

/** A status-word rule: a phrase pattern and the display statuses it selects. */
interface StatusRule {
  re: RegExp;
  statuses: DisplayStatus[];
  /** Reveals closed beads (sets `includeClosed`) — only the "done/closed" family. */
  closed?: boolean;
}

// Order matters only in that multi-word phrases must be consumed before the bare
// words they contain are seen by later passes — "in progress" is matched (and
// blanked) here so the city pass never reads a stray "in".
const STATUS_RULES: StatusRule[] = [
  { re: /\bin[-\s]?progress\b/g, statuses: ["in_progress"] },
  { re: /\b(?:active|running|wip|working)\b/g, statuses: ["in_progress"] },
  { re: /\bblocked\b/g, statuses: ["blocked"] },
  { re: /\bready\b/g, statuses: ["ready"] },
  { re: /\bescalat(?:ed|ion|ions)\b/g, statuses: ["escalated"] },
  { re: /\b(?:deferred|snoozed|sleeping)\b/g, statuses: ["deferred"] },
  // "failing" maps to the two attention-needing states this system actually has.
  { re: /\b(?:failing|failed|failures?|stuck|broken|problems?|attention)\b/g, statuses: ["blocked", "escalated"] },
  { re: /\b(?:closed|done|finished|complete|completed|merged|resolved)\b/g, statuses: ["closed"], closed: true },
];

/** A type-word rule mapping a phrase to a bead `issue_type`. */
interface TypeRule {
  re: RegExp;
  type: string;
}

const TYPE_RULES: TypeRule[] = [
  { re: /\bbugs?\b/g, type: "bug" },
  { re: /\bfeatures?\b/g, type: "feature" },
  { re: /\bchores?\b/g, type: "chore" },
  { re: /\bepics?\b/g, type: "epic" },
  { re: /\btasks?\b/g, type: "task" },
];

/** A priority-word rule (the `p0`–`p3` numeric form is handled separately). */
interface PriorityRule {
  re: RegExp;
  priority: number;
}

const PRIORITY_RULES: PriorityRule[] = [
  { re: /\b(?:critical|urgent)\b/g, priority: 0 },
  { re: /\bhigh[-\s]?(?:priority|pri)\b/g, priority: 1 },
  { re: /\bnormal[-\s]?(?:priority|pri)\b/g, priority: 2 },
  { re: /\blow[-\s]?(?:priority|pri)\b/g, priority: 3 },
];

// Filler/structural words that never count as an unrecognised term: selectors,
// the bead noun, prepositions, scope/dimension words, the colloquial "open"
// family (a deliberate no-op — closed are hidden by default), and the text/limit
// connectives whose *value* is captured separately.
const STOPWORDS = new Set([
  "show", "list", "find", "get", "give", "display", "me", "all", "the", "a", "an",
  "please", "with", "of", "that", "are", "is", "be", "beads", "bead", "issue", "issues",
  "work", "item", "items", "ticket", "tickets", "in", "for", "on", "within", "city",
  "cities", "and", "or", "to", "by", "from", "any", "some", "my", "our", "their",
  "across", "every", "everywhere", "status", "priority", "type", "assigned", "owned",
  "open", "unfinished", "unresolved", "outstanding", "todo", "pending", "current",
  "matching", "containing", "mentioning", "about", "titled", "title", "named", "called",
  "top", "first", "max", "limit", "result", "results",
]);

// Words a "in <x>" / "for <x>" capture must never treat as a city name.
const CITY_NOISE = new Set(["all", "every", "the", "city", "cities", "a", "an", "any"]);

/** Parse a natural-language fleet query into a structured, explainable query. */
export function parseFleetQuery(rawInput: string): ParsedFleetQuery {
  const input = rawInput.trim();
  const filters: BeadFilters = { includeClosed: false };
  const statuses = new Set<DisplayStatus>();
  let cityScope: string | null = null;
  let limit: number | undefined;

  // Working copy we progressively blank as spans are consumed; what remains is
  // the residual scanned for unmatched terms.
  let work = ` ${input.toLowerCase()} `;
  const consume = (re: RegExp): boolean => {
    let hit = false;
    work = work.replace(re, () => {
      hit = true;
      return " ";
    });
    return hit;
  };

  // 1. Quoted text first, so its inner words are never read as keywords.
  const quoted = /"([^"]+)"|'([^']+)'/.exec(work);
  if (quoted) {
    const text = (quoted[1] ?? quoted[2]).trim();
    if (text) filters.text = text;
    work = work.replace(quoted[0], " ");
  }

  // 2. Status words (union; "closed/done" also reveals closed beads).
  for (const rule of STATUS_RULES) {
    if (consume(rule.re)) {
      for (const s of rule.statuses) statuses.add(s);
      if (rule.closed) filters.includeClosed = true;
    }
  }
  if (statuses.size > 0) {
    filters.status = [...statuses].sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b));
  }

  // 3. Type (first match wins — `issue_type` is single-valued).
  for (const rule of TYPE_RULES) {
    if (consume(rule.re)) {
      filters.type = rule.type;
      break;
    }
  }

  // 4. Priority: the explicit p0–p3 form, then the priority-word rules.
  const pNum = /\bp([0-3])\b/.exec(work);
  if (pNum) {
    filters.priority = Number(pNum[1]);
    work = work.replace(pNum[0], " ");
  } else {
    for (const rule of PRIORITY_RULES) {
      if (consume(rule.re)) {
        filters.priority = rule.priority;
        break;
      }
    }
  }

  // 5. Assignee — "unassigned", or an explicit "assigned to <agent>".
  if (consume(/\b(?:unassigned|unowned)\b/g)) {
    filters.assignee = "";
  } else {
    const who = /\b(?:assigned\s+to|owned\s+by)\s+([a-z0-9][\w./-]*)/.exec(work);
    if (who) {
      filters.assignee = who[1];
      work = work.replace(who[0], " ");
    }
  }

  // 6. Result cap — "top 10", "first 5", "limit 20", or "10 beads".
  const cap = /\b(?:top|first|limit(?:ed\s+to)?|max)\s+(\d+)\b/.exec(work) ?? /\b(\d+)\s+(?:beads?|results?|items?)\b/.exec(work);
  if (cap) {
    const n = Number(cap[1]);
    if (n > 0) limit = n;
    work = work.replace(cap[0], " ");
  }

  // 7. "matching <word>" text form (after status/type so it can't swallow them).
  if (filters.text === undefined) {
    const m = /\b(?:matching|containing|mentioning|about|titled?)\s+(\S+)/.exec(work);
    if (m) {
      filters.text = m[1];
      work = work.replace(m[0], " ");
    }
  }

  // 8. City scope: blank an explicit "all cities" (the default anyway, but this
  // keeps the words out of `unmatched`), else read a "in/for <city>" token.
  if (!consume(/\b(?:across\s+)?all\s+cities\b|\bevery\s+city\b|\bfleet[-\s]?wide\b|\beverywhere\b/g)) {
    const cityMatch = /\b(?:in|for|on|within)\s+(?:the\s+)?(?:city\s+)?([a-z0-9][\w.-]*)\b/.exec(work);
    if (cityMatch && !CITY_NOISE.has(cityMatch[1])) {
      cityScope = cityMatch[1];
      work = work.replace(cityMatch[0], " ");
    }
  }

  const query: FleetQuery = { filters, cityScope, ...(limit !== undefined ? { limit } : {}) };
  return {
    input,
    query,
    summary: describeQuery(query),
    unmatched: residual(work),
  };
}

// Stable status ordering for the `status` array and the summary (most
// actionable first), mirroring the explorer's display-status rank.
const STATUS_ORDER: DisplayStatus[] = ["in_progress", "ready", "blocked", "open", "deferred", "escalated", "closed"];

/** Significant words left after every recognised span was blanked. */
function residual(work: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of work.split(/[^a-z0-9.#/_-]+/i)) {
    const word = token.toLowerCase();
    if (word.length < 2 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/**
 * Deterministic, human-readable restatement of a structured query. Pure and
 * order-stable so the palette's "Interpreted as…" line — and the parser tests —
 * are predictable.
 */
export function describeQuery(query: FleetQuery): string {
  const { filters } = query;
  const parts: string[] = [];

  if (filters.status && filters.status.length > 0) {
    parts.push(filters.status.map(displayStatusLabel).join(" / "));
  }
  if (filters.type !== undefined) parts.push(`type ${filters.type}`);
  if (filters.priority !== undefined) parts.push(priorityLabel(filters.priority));
  if (filters.assignee !== undefined) parts.push(filters.assignee === "" ? "unassigned" : `@${filters.assignee}`);
  if (filters.text) parts.push(`matching "${filters.text}"`);

  const selector = parts.length > 0 ? parts.join(", ") : filters.includeClosed ? "all beads" : "open beads";
  const scope = query.cityScope === null ? "all cities" : `city ${query.cityScope}`;
  const cap = query.limit !== undefined ? ` · top ${query.limit}` : "";
  return `${selector} · ${scope}${cap}`;
}
