// Pure presentation for the web companion: a plain data snapshot → an HTML
// string. No `document`, no `window`, no I/O — the DOM shell (main.ts) fetches
// over `/v0` through the core boundary and hands the typed responses here, so
// every builder stays decoupled and unit-testable with plain fixtures
// (render.test.ts), exactly like the CLI target's render.ts.
//
// Reuse is the whole point of Phase 0 (docs/companion-web.md): the per-row copy
// comes from the same `core` formatters the VS Code panes use
// (`status`/`telemetry`/`beads`), and the loading / empty / error rows come from
// the shared cross-pane vocabulary (`src/ui/view-state`, docs/cross-pane-states.md)
// so a companion pane and an editor pane read in the same key.
import * as core from "../../src/core/index.ts";
import {
  type StateNotice,
  emptyNotice,
  errorNotice,
  loadingNotice,
} from "../../src/ui/index.ts";

/**
 * What a data-bearing pane knows about its content right now. Mirrors the
 * editor's loading → empty → error trio: `loading` is the first fetch in flight,
 * `error` is a failed fetch (its cause in `detail`), and `ready` carries the
 * snapshot (which may itself be empty — the body decides). One shape per pane so
 * the shell can swap states without each pane reinventing them.
 */
export type PaneView<T> =
  | { status: "loading" }
  | { status: "error"; detail: string }
  | { status: "ready"; data: T };

/** Escape the five HTML-significant characters; every dynamic string passes through here. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** A short glyph per tone — the browser analogue of the editor's codicon, kept aria-hidden. */
function toneGlyph(tone: StateNotice["tone"]): string {
  switch (tone) {
    case "loading":
      return "◐";
    case "error":
      return "!";
    case "empty":
    default:
      return "·";
  }
}

/**
 * Render one cross-pane {@link StateNotice} (loading / empty / error). The tone
 * drives the CSS class so two panes in the same state look identical, and the
 * label/detail copy is whatever the shared `view-state` factories baked.
 */
export function noticeHtml(notice: StateNotice): string {
  const detail = notice.detail
    ? `<p class="notice__detail">${escapeHtml(notice.detail)}</p>`
    : "";
  return (
    `<div class="notice notice--${notice.tone}" role="status">` +
    `<span class="notice__glyph" aria-hidden="true">${toneGlyph(notice.tone)}</span>` +
    `<div class="notice__body"><p class="notice__label">${escapeHtml(notice.label)}</p>${detail}</div>` +
    `</div>`
  );
}

/** A small status dot whose colour comes from the shared `StatusKind` ladder. */
function dot(kind: core.status.StatusKind): string {
  return `<span class="dot dot--${kind}" aria-hidden="true"></span>`;
}

/** A pill carrying a short status word (bead display status, stream state, …). */
function pill(text: string, modifier: string): string {
  return `<span class="pill pill--${modifier}">${escapeHtml(text)}</span>`;
}

// ---- fleet -----------------------------------------------------------------

function agentRowHtml(agent: core.status.AgentResponse): string {
  return (
    `<li class="row">${dot(core.status.agentStatusKind(agent))}` +
    `<span class="row__label">${escapeHtml(core.status.agentLabel(agent))}</span>` +
    `<span class="row__detail">${escapeHtml(core.status.agentDescription(agent))}</span></li>`
  );
}

function sessionRowHtml(session: core.status.SessionResponse): string {
  return (
    `<li class="row">${dot(core.status.sessionStatusKind(session))}` +
    `<span class="row__label">${escapeHtml(core.status.sessionLabel(session))}</span>` +
    `<span class="row__detail">${escapeHtml(core.status.sessionDescription(session))}</span></li>`
  );
}

function cityBlockHtml(
  city: core.status.CityInfo,
  agents: core.status.AgentResponse[],
  sessions: core.status.SessionResponse[],
): string {
  const head =
    `<div class="city__head">${dot(core.status.cityStatusKind(city))}` +
    `<span class="city__name">${escapeHtml(core.status.cityLabel(city))}</span>` +
    `<span class="city__detail">${escapeHtml(core.status.cityDescription(city))}</span></div>`;

  if (!city.running) {
    return `<section class="city">${head}<p class="city__note">stopped</p></section>`;
  }

  const agentList = agents.length
    ? `<ul class="rows">${agents.map(agentRowHtml).join("")}</ul>`
    : `<p class="city__note">no agents</p>`;
  const sessionList = sessions.length
    ? `<ul class="rows rows--sessions">${sessions.map(sessionRowHtml).join("")}</ul>`
    : "";

  return `<section class="city">${head}${agentList}${sessionList}</section>`;
}

/** The Fleet pane body: supervisor health, then every city's agents and sessions. */
export function renderFleetPane(view: PaneView<core.status.FleetSnapshot>): string {
  if (view.status === "loading") return noticeHtml(loadingNotice());
  if (view.status === "error") return noticeHtml(errorNotice("the fleet", view.detail));

  const snap = view.data;
  if (snap.cities.length === 0) {
    // `fetchFleetSnapshot` never throws — a dead supervisor surfaces as zero
    // cities plus the failed calls in `partialErrors`. Treat that as an error
    // (not a misleading "no cities") so an unreachable supervisor reads honestly.
    return snap.partialErrors.length
      ? noticeHtml(errorNotice("the fleet", snap.partialErrors.join(" · ")))
      : noticeHtml(emptyNotice("No cities registered"));
  }

  const header =
    `<div class="supervisor">${dot(core.status.supervisorStatusKind(snap.health))}` +
    `<span class="supervisor__label">${escapeHtml(core.status.supervisorLabel(snap.health))}</span>` +
    `<span class="supervisor__detail">${escapeHtml(core.status.supervisorDescription(snap.health))}</span></div>`;

  const cities = snap.cities
    .map((city) =>
      cityBlockHtml(
        city,
        snap.agentsByCity[city.name] ?? [],
        snap.sessionsByCity[city.name] ?? [],
      ),
    )
    .join("");

  const partial = snap.partialErrors.length
    ? `<div class="partial" role="status"><span class="partial__glyph" aria-hidden="true">!</span>` +
      `<ul class="partial__list">${snap.partialErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>`
    : "";

  return `${header}${partial}<div class="cities">${cities}</div>`;
}

// ---- beads -----------------------------------------------------------------

function beadRowHtml(record: core.beads.BeadRecord): string {
  const status = core.beads.deriveDisplayStatus(record);
  const bead = record.bead;
  const title = bead.title ?? "(untitled)";
  const meta = [core.beads.priorityLabel(bead.priority), core.beads.beadType(bead), core.beads.beadAssignee(bead)]
    .filter(Boolean)
    .join(" · ");
  return (
    `<li class="bead">${pill(core.beads.displayStatusLabel(status), `status-${status}`)}` +
    `<span class="bead__id">${escapeHtml(bead.id)}</span>` +
    `<span class="bead__title">${escapeHtml(title)}</span>` +
    `<span class="bead__meta">${escapeHtml(meta)}</span></li>`
  );
}

function beadCityHtml(city: core.beads.CityRecords): string {
  const head = `<div class="city__head"><span class="city__name">${escapeHtml(city.city)}</span>`;

  if (city.error) {
    return (
      `<section class="city">${head}` +
      `<span class="city__detail">error</span></div>` +
      noticeHtml(errorNotice(`beads for ${city.city}`, city.error)) +
      `</section>`
    );
  }
  if (!city.running) {
    return `<section class="city">${head}<span class="city__detail">stopped</span></div></section>`;
  }

  // Mirror the explorer's defaults: hide closed beads and operational wisps
  // (nudges / orders / patrols / sessions / mail), then sort actionable-first.
  const visible = core.beads.sortRecords(core.beads.filterRecords(city.records, core.beads.DEFAULT_FILTERS));
  const count = `<span class="city__detail">${visible.length} bead${visible.length === 1 ? "" : "s"}${city.partial ? " · partial" : ""}</span></div>`;

  const body = visible.length
    ? `<ul class="beads">${visible.map(beadRowHtml).join("")}</ul>`
    : noticeHtml(emptyNotice("No open beads"));

  return `<section class="city">${head}${count}${body}</section>`;
}

/** The Beads pane body: one block per city, beads filtered + sorted like the explorer. */
export function renderBeadsPane(view: PaneView<core.beads.ExplorerData>): string {
  if (view.status === "loading") return noticeHtml(loadingNotice());
  if (view.status === "error") return noticeHtml(errorNotice("beads", view.detail));

  const cities = view.data.cities;
  if (cities.length === 0) return noticeHtml(emptyNotice("No cities registered"));
  return `<div class="cities">${cities.map(beadCityHtml).join("")}</div>`;
}

// ---- telemetry -------------------------------------------------------------

function scopeRowHtml(scope: core.telemetry.ScopeRollup): string {
  const kind = core.telemetry.scopeStatusKind(scope);
  return (
    `<li class="row">${dot(kind as core.status.StatusKind)}` +
    `<span class="row__label">${escapeHtml(core.telemetry.scopeLabel(scope))}</span>` +
    `<span class="row__detail">${escapeHtml(core.telemetry.scopeDescription(scope))}</span></li>`
  );
}

function scopeListHtml(title: string, scopes: core.telemetry.ScopeRollup[]): string {
  const body = scopes.length
    ? `<ul class="rows">${scopes.map(scopeRowHtml).join("")}</ul>`
    : `<p class="city__note">none yet</p>`;
  return `<section class="city"><div class="city__head"><span class="city__name">${escapeHtml(title)}</span></div>${body}</section>`;
}

/**
 * The Telemetry pane body. Telemetry is event-sourced — it accumulates from the
 * `worker.operation` SSE feed — so before any event lands the pane shows the
 * shared loading notice, and once connected it shows the live rollups plus the
 * same "awaiting upstream instrumentation" honesty the editor pane keeps when
 * the supervisor reports no token/cost numbers yet.
 */
export function renderTelemetryPane(view: PaneView<core.telemetry.TelemetryState>): string {
  if (view.status === "loading") return noticeHtml(loadingNotice());
  if (view.status === "error") return noticeHtml(errorNotice("telemetry", view.detail));

  const state = view.data;
  const streamKind = core.telemetry.streamStatusKind(state.stream);
  const streamLabel = state.stream ? state.stream.state : "off";
  const head =
    `<div class="supervisor">${dot(streamKind as core.status.StatusKind)}` +
    `<span class="supervisor__label">${escapeHtml(core.telemetry.totalsSummary(state.totals))}</span>` +
    `<span class="supervisor__detail">stream ${escapeHtml(streamLabel)}</span></div>`;

  if (state.totals.operations === 0) {
    return `${head}${noticeHtml(emptyNotice("No operations observed yet", "Telemetry accumulates from the live event stream."))}`;
  }

  const advisory = !state.anyCostMeasured
    ? `<p class="advisory">Token &amp; cost not yet reported by the supervisor — counts shown, ${escapeHtml(core.telemetry.NOT_MEASURED)} elsewhere.</p>`
    : "";
  const evicted = state.evicted
    ? `<p class="advisory">Older scopes dropped (cap reached); totals stay exact.</p>`
    : "";

  return (
    `${head}${advisory}${evicted}` +
    `<div class="cities">${scopeListHtml("By agent", state.agents)}${scopeListHtml("By bead", state.beads)}</div>`
  );
}
